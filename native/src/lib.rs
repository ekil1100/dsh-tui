use std::io::IsTerminal;
use std::sync::Mutex;
use std::thread::JoinHandle;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use eye_declare::{
    App, Ctx, Element, ElementExt, Focus, FocusHandle, InputEvent, Keymap, MarkdownStyles, Task,
    TextAreaState, col, driver_tokio, key, keymap, markdown, row, text, text_area, viewport,
};
use napi::{Error, Result};
use napi_derive::napi;
use ratatui_core::style::{Color, Modifier, Style};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use unicode_segmentation::UnicodeSegmentation;

type Outcome = std::result::Result<(), String>;

#[derive(Clone, Deserialize)]
struct Prompt {
    id: String,
    hint: String,
}

#[derive(Clone, Deserialize)]
struct Command {
    name: String,
    description: String,
}

#[derive(Clone, Deserialize)]
struct ModelItem {
    value: String,
    label: String,
}

#[derive(Clone, Deserialize)]
struct Picker {
    id: String,
    items: Vec<ModelItem>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    User,
    Assistant,
    Tool,
    Notice,
    Error,
}

#[derive(Clone, Deserialize)]
struct Entry {
    kind: EntryKind,
    text: String,
}

#[derive(Clone, Default, Deserialize)]
struct Frame {
    committed: Vec<Entry>,
    active: String,
    mode: String,
    interaction: Option<Prompt>,
    model: String,
    cwd: String,
    commands: Vec<Command>,
    picker: Option<Picker>,
}

#[derive(Clone)]
enum Msg {
    Frame(Box<Frame>),
    Edit(InputEvent),
    Submit,
    Complete,
    SaveModel,
    Eof,
    Escape,
    Interrupt,
    History(bool),
    EditKey(KeyCode),
    KillLine(bool),
    KillWord,
    Resize(u16, u16),
    Close,
}

struct TerminalApp {
    header: String,
    frame: Frame,
    input: TextAreaState,
    saved_input: Option<TextAreaState>,
    history: Vec<String>,
    history_index: Option<usize>,
    history_draft: Option<TextAreaState>,
    candidate: usize,
    menu_dismissed: bool,
    focus: FocusHandle,
    rows: u16,
    cols: u16,
    color: bool,
    receiver: Option<UnboundedReceiver<Msg>>,
    events: UnboundedSender<String>,
    task: Option<Task>,
}

impl TerminalApp {
    fn style(&self, color: Color) -> Style {
        if self.color {
            Style::default().fg(color)
        } else {
            Style::default()
        }
    }

    fn models(&self) -> Vec<&ModelItem> {
        if self.frame.interaction.is_some() {
            return Vec::new();
        }
        let query = self.input.text().to_lowercase();
        self.frame
            .picker
            .as_ref()
            .map(|picker| {
                picker
                    .items
                    .iter()
                    .filter(|item| item.label.to_lowercase().contains(&query))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn choose_model(&self, save: bool) {
        if let Some(picker) = &self.frame.picker {
            let models = self.models();
            if let Some(item) = models.get(self.candidate.min(models.len().saturating_sub(1))) {
                let _ = self.events.send(
                    json!({"type": "pick", "id": picker.id, "value": item.value, "save": save})
                        .to_string(),
                );
            }
        }
    }

    fn completions(&self) -> Vec<&Command> {
        if self.frame.picker.is_some()
            || self.menu_dismissed
            || self.frame.interaction.is_some()
            || self.frame.mode == "command"
        {
            return Vec::new();
        }
        let input = self.input.text();
        let Some(query) = input.strip_prefix('/') else {
            return Vec::new();
        };
        if query.chars().any(char::is_whitespace) {
            return Vec::new();
        }
        self.frame
            .commands
            .iter()
            .filter(|command| command.name.starts_with(query))
            .collect()
    }

    fn complete(&mut self, space: bool) {
        let candidates = self.completions();
        let Some(command) = candidates.get(self.candidate.min(candidates.len().saturating_sub(1)))
        else {
            return;
        };
        let value = format!("/{}{}", command.name, if space { " " } else { "" });
        self.input.set_text(&value);
        self.menu_dismissed = true;
    }

    fn edit_key(&mut self, code: KeyCode) {
        self.input
            .handle(&InputEvent::Key(KeyEvent::new(code, KeyModifiers::NONE)));
    }
}

impl App for TerminalApp {
    type Msg = Msg;
    type Output = ();

    fn init(&mut self, ctx: &mut Ctx<'_, Self>) {
        let receiver = self.receiver.take().expect("Initialize the terminal once");
        self.task = Some(
            ctx.spawn(futures::stream::unfold(receiver, |mut receiver| async {
                receiver.recv().await.map(|message| (message, receiver))
            })),
        );
        ctx.push(text(&self.header));
        let _ = self.events.send(json!({"type": "ready"}).to_string());
    }

    fn update(&mut self, message: Msg, ctx: &mut Ctx<'_, Self>) {
        match message {
            Msg::Frame(mut frame) => {
                let previous = self
                    .frame
                    .interaction
                    .as_ref()
                    .map(|prompt| &prompt.id)
                    .or(self.frame.picker.as_ref().map(|picker| &picker.id));
                let next = frame
                    .interaction
                    .as_ref()
                    .map(|prompt| &prompt.id)
                    .or(frame.picker.as_ref().map(|picker| &picker.id));
                if previous != next {
                    self.candidate = 0;
                    self.menu_dismissed = false;
                    match (previous, next) {
                        (None, Some(_)) => self.saved_input = Some(std::mem::take(&mut self.input)),
                        (Some(_), None) => {
                            self.input = self
                                .saved_input
                                .take()
                                .expect("Interaction must preserve the normal draft")
                        }
                        (Some(_), Some(_)) => {
                            self.input.take_text();
                        }
                        (None, None) => unreachable!(),
                    }
                }
                for committed in frame.committed.drain(..) {
                    match committed.kind {
                        EntryKind::User => {
                            let style = if self.color {
                                self.style(Color::Cyan).add_modifier(Modifier::BOLD)
                            } else {
                                Style::default()
                            };
                            ctx.push(text(committed.text).style(style).pad_top(1));
                        }
                        EntryKind::Assistant => {
                            let styles = if self.color {
                                MarkdownStyles::default()
                            } else {
                                MarkdownStyles {
                                    base: Style::default(),
                                    code_inline: Style::default(),
                                    code_block: Style::default(),
                                    bold: Style::default(),
                                    italic: Style::default(),
                                    heading: Style::default(),
                                    table_border: Style::default(),
                                    table_header: Style::default(),
                                }
                            };
                            ctx.push(markdown(committed.text).styles(styles).pad_top(1));
                        }
                        EntryKind::Tool => {
                            ctx.push(text(committed.text).style(self.style(Color::Green)))
                        }
                        EntryKind::Notice => ctx.push(text(committed.text)),
                        EntryKind::Error => {
                            ctx.push(text(committed.text).style(self.style(Color::Red)))
                        }
                    }
                }
                self.frame = *frame;
            }
            Msg::Edit(InputEvent::Paste(value)) => {
                self.menu_dismissed = false;
                self.candidate = 0;
                self.input
                    .insert_str(&value.replace("\r\n", " ").replace(['\r', '\n', '\t'], " "));
            }
            Msg::Edit(event) => {
                self.menu_dismissed = false;
                self.candidate = 0;
                self.input.handle(&event);
            }
            Msg::Complete => self.complete(true),
            Msg::SaveModel => {
                if self.frame.interaction.is_none() {
                    self.choose_model(true);
                }
            }
            Msg::Submit => {
                if self.frame.picker.is_some() && self.frame.interaction.is_none() {
                    self.choose_model(false);
                    return;
                }
                if self.frame.mode == "command" {
                    return;
                }
                self.complete(false);
                let value = self.input.take_text();
                if self.frame.interaction.is_none() && !value.trim().is_empty() {
                    self.history.push(value.clone());
                    self.history_index = None;
                    self.history_draft = None;
                }
                let _ = self.events.send(json!({"type": "submit", "text": value, "interactionId": self.frame.interaction.as_ref().map(|prompt| &prompt.id)}).to_string());
            }
            Msg::Eof => {
                if self.input.text().is_empty() {
                    let _ = self
                        .events
                        .send(json!({"type": "eof", "mode": self.frame.mode}).to_string());
                }
            }
            Msg::Escape => {
                if self.frame.interaction.is_none()
                    && let Some(picker) = &self.frame.picker
                {
                    let _ = self.events.send(
                        json!({"type": "pick", "id": picker.id, "value": null, "save": false})
                            .to_string(),
                    );
                    return;
                }
                if !self.completions().is_empty() {
                    self.menu_dismissed = true;
                    return;
                }
                if self.frame.mode == "idle" {
                    self.input.take_text();
                } else {
                    let _ = self
                        .events
                        .send(json!({"type": "escape", "mode": self.frame.mode}).to_string());
                }
            }
            Msg::Interrupt => {
                if self.frame.mode == "idle" && !self.input.text().is_empty() {
                    self.input.take_text();
                } else {
                    let _ = self
                        .events
                        .send(json!({"type": "interrupt", "mode": self.frame.mode}).to_string());
                }
            }
            Msg::History(previous) => {
                let count = if self.frame.picker.is_some() {
                    self.models().len()
                } else {
                    self.completions().len()
                };
                if count > 0 {
                    self.candidate =
                        (self.candidate + if previous { count - 1 } else { 1 }) % count;
                    return;
                }
                if self.frame.interaction.is_some()
                    || self.frame.picker.is_some()
                    || self.history.is_empty()
                {
                    return;
                }
                if previous {
                    let index = match self.history_index {
                        Some(index) => index.saturating_sub(1),
                        None => {
                            self.history_draft = Some(std::mem::take(&mut self.input));
                            self.history.len() - 1
                        }
                    };
                    self.history_index = Some(index);
                    self.input.set_text(&self.history[index]);
                } else if let Some(index) = self.history_index {
                    if index + 1 < self.history.len() {
                        self.history_index = Some(index + 1);
                        self.input.set_text(&self.history[index + 1]);
                    } else {
                        self.history_index = None;
                        self.input = self
                            .history_draft
                            .take()
                            .expect("History must preserve the draft");
                    }
                }
            }
            Msg::EditKey(code) => self.edit_key(code),
            Msg::KillLine(left) => {
                let column = self.input.cursor().1;
                let count = if left {
                    column
                } else {
                    self.input.text().graphemes(true).count() - column
                };
                for _ in 0..count {
                    self.edit_key(if left {
                        KeyCode::Backspace
                    } else {
                        KeyCode::Delete
                    });
                }
            }
            Msg::KillWord => {
                let value = self.input.text();
                let graphemes: Vec<_> = value.graphemes(true).collect();
                let column = self.input.cursor().1;
                let mut start = column;
                while start > 0 && graphemes[start - 1].chars().all(char::is_whitespace) {
                    start -= 1;
                }
                while start > 0 && !graphemes[start - 1].chars().all(char::is_whitespace) {
                    start -= 1;
                }
                for _ in start..column {
                    self.edit_key(KeyCode::Backspace);
                }
            }
            Msg::Resize(cols, rows) => {
                self.cols = cols;
                self.rows = rows;
            }
            Msg::Close => ctx.exit(()),
        }
    }

    fn tail(&self) -> impl Element + '_ {
        let height = self.rows.saturating_sub(1).clamp(1, 4);
        let mut tail = col();
        let candidates = self.completions();
        let models = self.models();
        let picking = self.frame.picker.is_some() && self.frame.interaction.is_none();
        if !picking && candidates.is_empty() {
            if height > 3 {
                tail = tail.child(viewport(self.frame.active.lines()).height(height - 3));
            }
            if height > 2 {
                tail = tail
                    .child(text("─".repeat(self.cols as usize)).style(self.style(Color::DarkGray)));
            }
        }
        tail = tail.child(
            row()
                .fixed(2, text("> ").style(self.style(Color::Cyan)))
                .fill(
                    text_area(&self.input)
                        .track_focus(&self.focus)
                        .max_height(1),
                ),
        );
        if picking && height > 2 {
            let count = (height - 2) as usize;
            let selected = self.candidate.min(models.len().saturating_sub(1));
            let start = selected.saturating_sub(count - 1);
            for index in start..start + count {
                let line = models
                    .get(index)
                    .map(|model| {
                        format!(
                            "{} {}",
                            if index == selected { ">" } else { " " },
                            model.label
                        )
                    })
                    .unwrap_or_else(|| {
                        if index == start {
                            "No matching models".into()
                        } else {
                            String::new()
                        }
                    });
                tail = tail.child(viewport([line]).wrap(false).style(self.style(
                    if index == selected {
                        Color::Cyan
                    } else {
                        Color::Reset
                    },
                )));
            }
        } else if !candidates.is_empty() && height > 2 {
            let count = (height - 2) as usize;
            let selected = self.candidate.min(candidates.len() - 1);
            let start = selected.saturating_sub(count - 1);
            for index in start..start + count {
                let line = candidates
                    .get(index)
                    .map(|command| {
                        format!(
                            "{} /{} — {}",
                            if index == selected { ">" } else { " " },
                            command.name,
                            command.description
                        )
                    })
                    .unwrap_or_default();
                tail = tail.child(viewport([line]).wrap(false).style(self.style(
                    if index == selected {
                        Color::Cyan
                    } else {
                        Color::Reset
                    },
                )));
            }
        }
        if height > 1 {
            let status = match self.frame.mode.as_str() {
                "running" => "running · Esc to stop",
                "command" => "command · Esc to cancel",
                _ => "idle · /help",
            };
            let status = if picking {
                "Select model · Enter choose · Ctrl+S save globally · Esc cancel"
            } else if candidates.is_empty() {
                status
            } else {
                "Tab complete · Enter run · Esc close"
            };
            let hint = self
                .frame
                .interaction
                .as_ref()
                .map(|prompt| prompt.hint.as_str())
                .unwrap_or(status);
            let footer = if picking {
                hint.to_string()
            } else {
                format!("{} · {} · {}", self.frame.model, hint, self.frame.cwd)
            };
            tail = tail.child(viewport([footer]).wrap(false));
        }
        tail
    }

    fn keymap(&self) -> Keymap<Msg> {
        keymap()
            .on_override(key(KeyCode::Esc), Msg::Escape)
            .on_override(key(KeyCode::Char('c')).ctrl(), Msg::Interrupt)
            .on_override(key(KeyCode::Char('d')).ctrl(), Msg::Eof)
            .on_override(key(KeyCode::Char('s')).ctrl(), Msg::SaveModel)
            .on_override(key(KeyCode::Char('a')).ctrl(), Msg::EditKey(KeyCode::Home))
            .on_override(key(KeyCode::Char('e')).ctrl(), Msg::EditKey(KeyCode::End))
            .on_override(key(KeyCode::Char('u')).ctrl(), Msg::KillLine(true))
            .on_override(key(KeyCode::Char('k')).ctrl(), Msg::KillLine(false))
            .on_override(key(KeyCode::Char('w')).ctrl(), Msg::KillWord)
            .in_scope(&self.focus, key(KeyCode::Enter), Msg::Submit)
            .in_scope(&self.focus, key(KeyCode::Tab), Msg::Complete)
            .in_scope(&self.focus, key(KeyCode::Up), Msg::History(true))
            .in_scope(&self.focus, key(KeyCode::Down), Msg::History(false))
            .fallthrough(&self.focus, Msg::Edit)
    }

    fn on_resize(&self, width: u16, height: u16) -> Option<Msg> {
        Some(Msg::Resize(width, height))
    }
}

/// One terminal driver on a dedicated thread; JavaScript only exchanges owned messages.
#[napi]
pub struct NativeTerminal {
    commands: UnboundedSender<Msg>,
    events: tokio::sync::Mutex<UnboundedReceiver<String>>,
    thread: Mutex<Option<JoinHandle<Outcome>>>,
}

#[napi]
impl NativeTerminal {
    #[napi(constructor)]
    pub fn new(header: String) -> Result<Self> {
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(Error::from_reason("dsh-tui requires an interactive TTY"));
        }
        let (commands, receiver) = unbounded_channel();
        let (events, event_receiver) = unbounded_channel();
        let thread = std::thread::Builder::new()
            .name("dsh-tui".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?;
                let focus = Focus::new();
                let input_focus = focus.handle();
                input_focus.focus();
                let (cols, rows) =
                    crossterm::terminal::size().map_err(|error| error.to_string())?;
                runtime
                    .block_on(driver_tokio::run(TerminalApp {
                        header,
                        frame: Frame {
                            mode: "idle".into(),
                            ..Frame::default()
                        },
                        input: TextAreaState::new(),
                        saved_input: None,
                        history: Vec::new(),
                        history_index: None,
                        history_draft: None,
                        candidate: 0,
                        menu_dismissed: false,
                        focus: input_focus,
                        rows,
                        cols,
                        color: std::env::var_os("NO_COLOR").is_none_or(|value| value.is_empty()),
                        receiver: Some(receiver),
                        events,
                        task: None,
                    }))
                    .map_err(|error| error.to_string())
            })
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(Self {
            commands,
            events: tokio::sync::Mutex::new(event_receiver),
            thread: Mutex::new(Some(thread)),
        })
    }

    #[napi]
    pub fn render(&self, frame: String) -> Result<()> {
        let frame =
            serde_json::from_str(&frame).map_err(|error| Error::from_reason(error.to_string()))?;
        self.commands
            .send(Msg::Frame(frame))
            .map_err(|_| Error::from_reason("Terminal has closed"))
    }

    #[napi]
    pub async fn next_event(&self) -> Option<String> {
        self.events.lock().await.recv().await
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let _ = self.commands.send(Msg::Close);
        let thread = self
            .thread
            .lock()
            .map_err(|_| Error::from_reason("Terminal thread lock poisoned"))?
            .take();
        if let Some(thread) = thread {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|error| Error::from_reason(error.to_string()))?
                .map_err(|_| Error::from_reason("Terminal renderer panicked"))?
                .map_err(Error::from_reason)?;
        }
        Ok(())
    }
}

impl Drop for NativeTerminal {
    fn drop(&mut self) {
        let _ = self.commands.send(Msg::Close);
    }
}
