//! A committed block must replace every live cell before it enters scrollback.

use eye_declare_engine::{Engine, frame::Frame, test_terminal::TestTerminal};
use ratatui_core::{buffer::Buffer, layout::Rect, style::Style};

fn lines(width: u16, rows: &[&str]) -> Buffer {
    let mut buffer = Buffer::empty(Rect::new(0, 0, width, rows.len() as u16));
    for (y, row) in rows.iter().enumerate() {
        buffer.set_stringn(0, y as u16, row, width as usize, Style::default());
    }
    buffer
}

#[test]
fn large_commit_replaces_live_rows_including_blanks_and_short_lines() {
    let mut terminal = TestTerminal::new(24, 8);
    let mut engine = Engine::new(24, 8);
    terminal.feed(&engine.commit(&lines(24, &["earlier history"])));
    let tail = [
        "PREVIEW",
        "---- Working ----",
        "draft",
        "-----------------",
        "MODEL footer",
    ];
    terminal.feed(&engine.present(Frame::new(lines(24, &tail)), Some((2, 2))));
    let answer = [
        "", "TITLE", "", "one", "", "two", "", "three", "", "four", "", "END",
    ];
    terminal.feed(&engine.commit(&lines(24, &answer)));
    let idle = ["---- Idle ----", "draft", "---------------", "MODEL footer"];
    terminal.feed(&engine.present(Frame::new(lines(24, &idle)), Some((2, 1))));

    let mut actual = terminal.scrollback_lines();
    actual.extend(terminal.viewport_lines());
    while actual.last().is_some_and(String::is_empty) {
        actual.pop();
    }
    let expected: Vec<_> = ["earlier history"]
        .into_iter()
        .chain(answer)
        .chain(idle)
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(terminal.cursor().1, 2);
}
