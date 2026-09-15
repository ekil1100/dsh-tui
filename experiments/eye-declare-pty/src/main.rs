// Diagnostic fixture only. Rendering, input editing, and resize use the published framework.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use crossterm::event::KeyCode;
use eye_declare::{
    App, Ctx, Element, Focus, FocusHandle, InputEvent, Keymap, Task, TextAreaState, col,
    driver_tokio, key, keymap, row, text, text_area,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

#[derive(Clone, Default, Deserialize)]
struct FrameUpdate {
    items: Option<Vec<String>>,
    frame: Option<u32>,
    fail: Option<bool>,
}

#[derive(Clone, Deserialize)]
struct Command {
    id: Option<u32>,
    action: Option<String>,
    state: Option<FrameUpdate>,
}

#[derive(Clone)]
enum Msg {
    Command(Command),
    Edit(InputEvent),
    Submit,
    Resize(u16, u16),
    Quit(u8),
}

struct Probe {
    input: TextAreaState,
    input_focus: FocusHandle,
    frame: u32,
    fail: bool,
    committed: usize,
    columns: u16,
    rows: u16,
    receiver: Option<UnboundedReceiver<Msg>>,
    task: Option<Task>,
    socket: UnixStream,
}

impl Probe {
    fn reply(&mut self, message: serde_json::Value) {
        writeln!(self.socket, "{message}").expect("Probe control socket must remain open");
    }
}

impl App for Probe {
    type Msg = Msg;
    type Output = u8;

    fn init(&mut self, ctx: &mut Ctx<'_, Self>) {
        let receiver = self.receiver.take().expect("Initialize once");
        self.task = Some(
            ctx.spawn(futures::stream::unfold(receiver, |mut receiver| async {
                receiver.recv().await.map(|message| (message, receiver))
            })),
        );
        self.reply(json!({"ready": true, "pid": std::process::id()}));
    }

    fn update(&mut self, msg: Msg, ctx: &mut Ctx<'_, Self>) {
        match msg {
            Msg::Command(command) => {
                if command.action.as_deref() == Some("close") {
                    ctx.exit(0);
                    return;
                }
                if let Some(state) = command.state {
                    if let Some(items) = state.items {
                        for item in &items[self.committed..] {
                            ctx.push(text(item));
                        }
                        self.committed = items.len();
                    }
                    if let Some(frame) = state.frame {
                        self.frame = frame;
                    }
                    if let Some(fail) = state.fail {
                        self.fail = fail;
                    }
                }
                if let Some(id) = command.id {
                    self.reply(json!({"ack": id}));
                }
            }
            Msg::Edit(InputEvent::Paste(value)) => {
                // Single-line paste policy belongs to the application, not the editor.
                let value = value.replace("\r\n", " ").replace(['\r', '\n'], " ");
                self.input.insert_str(&value);
            }
            Msg::Edit(event) => self.input.handle(&event),
            Msg::Submit => ctx.push(text(format!("INPUT:{}", self.input.take_text()))),
            Msg::Resize(columns, rows) => {
                self.columns = columns;
                self.rows = rows;
            }
            Msg::Quit(code) => ctx.exit(code),
        }
    }

    fn tail(&self) -> impl Element + '_ {
        assert!(!self.fail, "PROBE_RENDER_FAILURE");
        let height = self.rows.saturating_sub(1).clamp(1, 4);
        let mut tail = col();
        for index in 0..height - 1 {
            let line: String = format!("LIVE{}:{index}", self.frame)
                .chars()
                .take(self.columns.into())
                .collect();
            tail = tail.child(text(line));
        }
        tail.child(
            row().fixed(2, text("> ")).fill(
                text_area(&self.input)
                    .track_focus(&self.input_focus)
                    .max_height(1),
            ),
        )
    }

    fn keymap(&self) -> Keymap<Msg> {
        keymap()
            .on_override(key(KeyCode::Char('c')).ctrl(), Msg::Quit(130))
            .on_override(key(KeyCode::Char('d')).ctrl(), Msg::Quit(0))
            .in_scope(&self.input_focus, key(KeyCode::Enter), Msg::Submit)
            .fallthrough(&self.input_focus, Msg::Edit)
    }

    fn on_resize(&self, width: u16, height: u16) -> Option<Msg> {
        Some(Msg::Resize(width, height))
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let socket_path = std::env::var("INK_PROBE_SOCKET").expect("Run through the PTY harness");
    let socket = UnixStream::connect(socket_path).expect("Connect to the PTY harness");
    let reader = BufReader::new(socket.try_clone().expect("Clone control socket"));
    let (sender, receiver) = unbounded_channel();
    // The host must route process signals into normal runtime shutdown; Drop alone is insufficient.
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .expect("Register SIGINT");
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Register SIGTERM");
    let signal_sender = sender.clone();
    tokio::spawn(async move {
        let code = tokio::select! {
            _ = interrupt.recv() => 130,
            _ = terminate.recv() => 143,
        };
        let _ = signal_sender.send(Msg::Quit(code));
    });
    std::thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let command: Command = serde_json::from_str(&line).expect("Valid probe command");
            if sender.send(Msg::Command(command)).is_err() {
                break;
            }
        }
    });
    let focus = Focus::new();
    let input_focus = focus.handle();
    if std::env::var("INK_PROBE_CURSOR").as_deref() != Ok("false") {
        input_focus.focus();
    }
    let result = driver_tokio::run(Probe {
        input: TextAreaState::new(),
        input_focus,
        frame: 0,
        fail: false,
        committed: 0,
        columns: 80,
        rows: 24,
        receiver: Some(receiver),
        task: None,
        socket,
    })
    .await;
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("Probe failed: {error}");
            ExitCode::FAILURE
        }
    }
}
