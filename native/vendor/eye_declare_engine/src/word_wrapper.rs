//! WordWrapper from ratatui-widgets 0.3.2 (src/reflow.rs), with the next
//! grapheme's width included in the overflow check. See LICENSE-ratatui.
//! Keep this private: measuring and rendering share it through wrap.rs.

use std::collections::VecDeque;
use std::mem;

use ratatui_core::buffer::CellWidth;
use ratatui_core::layout::Alignment;
use ratatui_core::text::StyledGrapheme;

/// A state machine to pack styled symbols into lines.
/// Cannot implement it as Iterator since it yields slices of the internal buffer (need streaming
/// iterators for that).
pub(crate) trait LineComposer<'a> {
    fn next_line<'lend>(&'lend mut self) -> Option<WrappedLine<'lend, 'a>>;
}

/// A line that has been wrapped to a certain width.
pub(crate) struct WrappedLine<'lend, 'text> {
    /// One line reflowed to the correct width
    pub graphemes: &'lend [StyledGrapheme<'text>],
    /// Whether the line was aligned left or right
    pub alignment: Alignment,
}

/// A state machine that wraps lines on word boundaries.
#[derive(Debug, Default, Clone)]
pub(crate) struct WordWrapper<'a, O, I>
where
    O: Iterator<Item = (I, Alignment)>,
    I: Iterator<Item = StyledGrapheme<'a>>,
{
    input_lines: O,
    max_line_width: u16,
    wrapped_lines: VecDeque<Vec<StyledGrapheme<'a>>>,
    current_alignment: Alignment,
    current_line: Vec<StyledGrapheme<'a>>,
    trim: bool,

    // These are cached allocations that hold no state across next_line invocations.
    pending_word: Vec<StyledGrapheme<'a>>,
    pending_whitespace: VecDeque<StyledGrapheme<'a>>,
    pending_line_pool: Vec<Vec<StyledGrapheme<'a>>>,
}

impl<'a, O, I> WordWrapper<'a, O, I>
where
    O: Iterator<Item = (I, Alignment)>,
    I: Iterator<Item = StyledGrapheme<'a>>,
{
    pub const fn new(lines: O, max_line_width: u16, trim: bool) -> Self {
        Self {
            input_lines: lines,
            max_line_width,
            wrapped_lines: VecDeque::new(),
            current_alignment: Alignment::Left,
            current_line: vec![],
            trim,
            pending_word: Vec::new(),
            pending_line_pool: Vec::new(),
            pending_whitespace: VecDeque::new(),
        }
    }

    fn process_input(&mut self, line_symbols: impl IntoIterator<Item = StyledGrapheme<'a>>) {
        let mut pending_line = self.pending_line_pool.pop().unwrap_or_default();
        let mut line_width = 0;
        let mut word_width = 0;
        let mut whitespace_width = 0;
        let mut non_whitespace_previous = false;

        self.pending_word.clear();
        self.pending_whitespace.clear();
        pending_line.clear();

        for grapheme in line_symbols {
            let is_whitespace = grapheme.is_whitespace();
            let symbol_width = grapheme.symbol.cell_width();
            if symbol_width > self.max_line_width {
                continue;
            }

            let word_found = non_whitespace_previous && is_whitespace;
            let trimmed_overflow = pending_line.is_empty()
                && self.trim
                && word_width + symbol_width > self.max_line_width;
            let whitespace_overflow = pending_line.is_empty()
                && self.trim
                && whitespace_width + symbol_width > self.max_line_width;
            let untrimmed_overflow = pending_line.is_empty()
                && !self.trim
                && word_width + whitespace_width + symbol_width > self.max_line_width;

            if word_found || trimmed_overflow || whitespace_overflow || untrimmed_overflow {
                if !pending_line.is_empty() || !self.trim {
                    pending_line.extend(self.pending_whitespace.drain(..));
                    line_width += whitespace_width;
                }
                pending_line.append(&mut self.pending_word);
                line_width += word_width;
                self.pending_whitespace.clear();
                whitespace_width = 0;
                word_width = 0;
            }

            let line_full = line_width >= self.max_line_width;
            // Upstream only checks the occupied width, allowing a two-column
            // grapheme into the last column and triggering an untracked wrap.
            let pending_word_overflow = symbol_width > 0
                && line_width + whitespace_width + word_width + symbol_width > self.max_line_width;

            if line_full || pending_word_overflow {
                let mut remaining_width = u16::saturating_sub(self.max_line_width, line_width);
                self.wrapped_lines.push_back(mem::take(&mut pending_line));
                line_width = 0;
                while let Some(grapheme) = self.pending_whitespace.front() {
                    let width = grapheme.symbol.cell_width();
                    if width > remaining_width {
                        break;
                    }
                    whitespace_width -= width;
                    remaining_width -= width;
                    self.pending_whitespace.pop_front();
                }
                if is_whitespace && self.pending_whitespace.is_empty() {
                    continue;
                }
            }

            if is_whitespace {
                whitespace_width += symbol_width;
                self.pending_whitespace.push_back(grapheme);
            } else {
                word_width += symbol_width;
                self.pending_word.push(grapheme);
            }
            non_whitespace_previous = !is_whitespace;
        }

        if pending_line.is_empty()
            && self.pending_word.is_empty()
            && !self.pending_whitespace.is_empty()
            && self.trim
        {
            self.wrapped_lines.push_back(vec![]);
        }
        if !pending_line.is_empty() || !self.trim {
            pending_line.extend(self.pending_whitespace.drain(..));
        }
        pending_line.append(&mut self.pending_word);
        if !pending_line.is_empty() {
            self.wrapped_lines.push_back(pending_line);
        } else if pending_line.capacity() > 0 {
            self.pending_line_pool.push(pending_line);
        }
        if self.wrapped_lines.is_empty() {
            self.wrapped_lines.push_back(vec![]);
        }
    }

    fn replace_current_line(&mut self, line: Vec<StyledGrapheme<'a>>) {
        let cache = mem::replace(&mut self.current_line, line);
        if cache.capacity() > 0 {
            self.pending_line_pool.push(cache);
        }
    }
}

impl<'a, O, I> LineComposer<'a> for WordWrapper<'a, O, I>
where
    O: Iterator<Item = (I, Alignment)>,
    I: Iterator<Item = StyledGrapheme<'a>>,
{
    fn next_line<'lend>(&'lend mut self) -> Option<WrappedLine<'lend, 'a>> {
        if self.max_line_width == 0 {
            return None;
        }
        loop {
            if let Some(line) = self.wrapped_lines.pop_front() {
                self.replace_current_line(line);
                return Some(WrappedLine {
                    graphemes: &self.current_line,
                    alignment: self.current_alignment,
                });
            }
            let (line_symbols, line_alignment) = self.input_lines.next()?;
            self.current_alignment = line_alignment;
            self.process_input(line_symbols);
        }
    }
}
