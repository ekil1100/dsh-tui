use ratatui_core::buffer::Buffer;
use ratatui_core::layout::{Alignment, Rect};
use ratatui_core::text::{Line, Span, Text};
use ratatui_core::widgets::Widget;

use crate::word_wrapper::{LineComposer, WordWrapper};

fn composer<'a>(text: &'a Text<'_>, width: u16, alignment: Alignment) -> impl LineComposer<'a> {
    let lines = text.lines.iter().map(move |line| {
        (
            line.styled_graphemes(text.style),
            line.alignment.unwrap_or(alignment),
        )
    });
    WordWrapper::new(lines, width, false)
}

/// Measure using the same corrected word wrapper as [`render_wrapped`].
pub fn wrapped_line_count(text: &Text<'_>, width: u16) -> u16 {
    let mut lines = composer(text, width, Alignment::Left);
    let mut count = 0u16;
    while lines.next_line().is_some() {
        count = count.saturating_add(1);
    }
    count
}

/// Render complete wrapped graphemes, preserving styles, alignment, and indentation.
/// Ratatui still renders each line; the shared composer keeps wide glyphs inside it.
pub fn render_wrapped(
    text: Text<'_>,
    alignment: Alignment,
    scroll_rows: u16,
    area: Rect,
    buf: &mut Buffer,
) {
    let area = area.intersection(buf.area);
    if area.is_empty() {
        return;
    }
    let mut lines = composer(&text, area.width, alignment);
    for _ in 0..scroll_rows {
        if lines.next_line().is_none() {
            return;
        }
    }
    for y in area.top()..area.bottom() {
        let Some(wrapped) = lines.next_line() else {
            break;
        };
        let spans = wrapped
            .graphemes
            .iter()
            .map(|g| Span::styled(g.symbol, g.style))
            .collect::<Vec<_>>();
        Line::from(spans)
            .alignment(wrapped.alignment)
            .render(Rect::new(area.x, y, area.width, 1), buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui_core::text::Text;

    fn text_from(s: &str) -> Text<'_> {
        Text::from(s)
    }

    #[test]
    fn short_text_no_wrap() {
        let text = text_from("hello");
        assert_eq!(wrapped_line_count(&text, 80), 1);
    }

    #[test]
    fn text_wraps_at_width() {
        // "hello world" is 11 chars. At width 6, should wrap to 2 lines.
        let text = text_from("hello world");
        assert_eq!(wrapped_line_count(&text, 6), 2);
    }

    #[test]
    fn wide_word_moves_to_the_next_row_before_crossing_the_right_edge() {
        let text = text_from("a 中文");
        assert_eq!(wrapped_line_count(&text, 5), 2);
    }

    #[test]
    fn wide_graphemes_stay_inside_rows_without_losing_text() {
        use unicode_width::UnicodeWidthStr;

        for source in [
            "a 中文😀 a中文b e\u{301}".to_string(),
            format!(
                "**Summary** {}",
                "A streamed paragraph 中文 must remain above the editor. ".repeat(12)
            ),
        ] {
            for width in 2..=132 {
                let text = text_from(&source);
                let rows = wrapped_line_count(&text, width);
                let area = Rect::new(0, 0, width, rows);
                let mut buf = Buffer::empty(area);
                render_wrapped(text, Alignment::Left, 0, area, &mut buf);
                let mut visible = String::new();
                for y in 0..rows {
                    let mut x = 0;
                    while x < width {
                        let symbol = buf[(x, y)].symbol();
                        let columns = symbol.width() as u16;
                        assert!(
                            x + columns <= width,
                            "Wide glyph crosses row {y} at width {width}"
                        );
                        visible.push_str(symbol);
                        x += columns.max(1);
                    }
                }
                let compact = |value: &str| {
                    value
                        .chars()
                        .filter(|c| !c.is_whitespace())
                        .collect::<String>()
                };
                assert_eq!(
                    compact(&visible),
                    compact(&source),
                    "Text lost at width {width}"
                );
            }
        }
    }

    #[test]
    fn wrapped_scrolling_preserves_styles_alignment_and_adjacent_rows() {
        use ratatui_core::style::{Color, Modifier, Style};

        let style = Style::default()
            .fg(Color::Blue)
            .add_modifier(Modifier::BOLD);
        let text = Text::from(Line::from(vec![
            Span::raw("a "),
            Span::styled("中文", style),
        ]));
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 3));
        buf.set_string(0, 2, "GUARD", Style::default());
        render_wrapped(text, Alignment::Right, 1, Rect::new(2, 1, 5, 1), &mut buf);
        assert_eq!(buf[(3, 1)].symbol(), "中");
        assert_eq!(buf[(5, 1)].symbol(), "文");
        for x in [3, 5] {
            assert_eq!(buf[(x, 1)].fg, Color::Blue);
            assert!(buf[(x, 1)].modifier.contains(Modifier::BOLD));
        }
        for (x, ch) in "GUARD".chars().enumerate() {
            assert_eq!(buf[(x as u16, 2)].symbol(), ch.to_string());
        }
        assert_eq!(buf[(7, 1)].symbol(), " ");
    }

    #[test]
    fn explicit_newlines_counted() {
        let text = text_from("line1\nline2\nline3");
        assert_eq!(wrapped_line_count(&text, 80), 3);
    }

    #[test]
    fn empty_text() {
        // ratatui's Paragraph counts an empty text as 1 line (the empty line).
        // Components should guard with is_empty() before calling wrapped_line_count.
        let text = text_from("");
        assert_eq!(wrapped_line_count(&text, 80), 1);
    }

    #[test]
    fn zero_width() {
        let text = text_from("hello");
        assert_eq!(wrapped_line_count(&text, 0), 0);
    }

    /// The same fix handles the old width-2 overflow without truncating whole lines.
    #[test]
    fn narrow_widths_wrap_without_crossing_the_buffer_edge() {
        use ratatui_core::buffer::Buffer;
        use ratatui_core::layout::{Alignment, Rect};
        use ratatui_core::text::Line;

        for source in ["a\u{4f49}b", "x\u{604}<!", "one\ntwo\nthree"] {
            let text = Text::from(source.split('\n').map(Line::raw).collect::<Vec<_>>());
            for width in 1..=4u16 {
                let rows = wrapped_line_count(&text, width);
                let area = Rect::new(0, 0, width, rows.max(1));
                let mut buf = Buffer::empty(area);
                render_wrapped(text.clone(), Alignment::Left, 0, area, &mut buf);
            }
        }
        assert_eq!(wrapped_line_count(&text_from("a佉b"), 2), 3);
        assert_eq!(wrapped_line_count(&text_from("one\ntwo"), 2), 4);
    }

    #[test]
    fn long_paragraph_wraps() {
        let text = text_from(
            "This is a longer paragraph that should wrap across multiple lines \
             when rendered at a narrow terminal width.",
        );
        let count = wrapped_line_count(&text, 40);
        assert!(count >= 3, "expected >= 3 lines at width 40, got {}", count);
    }

    #[test]
    fn wrap_with_newlines_and_long_lines() {
        let text = text_from("short\nthis line is longer than twenty characters");
        let count = wrapped_line_count(&text, 20);
        // "short" = 1 line, "this line is longer than twenty characters" wraps to 3+ lines
        assert!(count >= 3, "expected >= 3 lines, got {}", count);
    }
}
