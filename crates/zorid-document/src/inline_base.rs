//! Select a real saved fenced Base block, never caller-supplied replacement YAML.
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InlineBaseSource {
    /// CommonMark-normalized content, including its terminal newline when present.
    pub source: String,
    /// UTF-8 byte span of the complete fence, excluding the closing line ending.
    pub start_byte: usize,
    pub end_byte: usize,
}

/// The caller must first verify `saved` against its retained entry commitment.
/// Offsets and normalized content are checked together against the Markdown
/// parser, so a similar-looking block nested inside another code fence cannot
/// authorize arbitrary configuration.
pub fn verify_inline_base_source(saved: &str, selected: &InlineBaseSource) -> bool {
    if selected.source.len() > 262_144 || selected.start_byte >= selected.end_byte {
        return false;
    }
    let Some(block) = saved.get(selected.start_byte..selected.end_byte) else { return false; };
    let Some(opening_end) = block.find('\n') else { return false; };
    let opening = block[..opening_end].trim_end_matches([' ', '\t', '\r']);
    let Some(before_info) = opening.strip_suffix("base") else { return false; };
    let before_info = before_info.trim_end_matches([' ', '\t']);
    let Some(marker @ (b'`' | b'~')) = before_info.as_bytes().last().copied() else { return false; };
    let fence_len = before_info.bytes().rev().take_while(|byte| *byte == marker).count();
    if fence_len < 3 { return false; }
    let closing_start = selected.start_byte + block.rfind('\n').unwrap() + 1;
    let closing = block.rsplit('\n').next().unwrap_or_default().trim_end_matches([' ', '\t', '\r']);
    let closing_len = closing.bytes().rev().take_while(|byte| *byte == marker).count();
    if closing_len < fence_len { return false; }

    let mut text = None;
    for (event, range) in Parser::new_ext(saved, Options::ENABLE_YAML_STYLE_METADATA_BLOCKS).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let end = saved[..range.end].trim_end_matches(['\r', '\n']).len();
                // Nested list/blockquote prefixes and indentation belong to the
                // selected raw lines, while the parser excludes those prefixes.
                let line_start = saved[..range.start].rfind('\n').map_or(0, |at| at + 1);
                if line_start == selected.start_byte && end == selected.end_byte && info.as_ref() == "base" {
                    text = Some(String::new());
                }
            }
            Event::Text(value) if text.is_some() => {
                // An unclosed block may end in fence-looking code text. Only a
                // real parser-recognized closing line is outside its text spans.
                if range.end > closing_start { return false; }
                let target = text.as_mut().unwrap();
                if target.len().saturating_add(value.len()) > 262_144 { return false; }
                target.push_str(&value);
            }
            Event::End(TagEnd::CodeBlock) if text.is_some() => {
                return text.as_deref() == Some(selected.source.as_str());
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(note: &str, block: &str, source: &str) -> InlineBaseSource {
        let start_byte = note.find(block).unwrap();
        InlineBaseSource { source: source.into(), start_byte, end_byte: start_byte + block.len() }
    }

    #[test]
    fn saved_fences_require_exact_span_source_and_real_markdown_context() {
        let block = "```base\nviews: []\n```";
        let note = format!("# Café\n\n{block}\nOther\n");
        let selected = selection(&note, block, "views: []\n");
        assert!(verify_inline_base_source(&note, &selected));
        assert!(!verify_inline_base_source(&note, &InlineBaseSource { source: "views: [fake]\n".into(), ..selected.clone() }));
        assert!(!verify_inline_base_source(&note, &InlineBaseSource { end_byte: selected.end_byte + 1, ..selected.clone() }));
        let nested = format!("````markdown\n{block}\n````");
        assert!(!verify_inline_base_source(&nested, &selection(&nested, block, "views: []\n")));
        let unclosed = "```base\nviews: []";
        assert!(!verify_inline_base_source(unclosed, &selection(unclosed, unclosed, "views: []")));
        let frontmatter = format!("---\nconfig: |\n  ```base\n  views: []\n  ```\n---\n");
        let fake = "  ```base\n  views: []\n  ```";
        assert!(!verify_inline_base_source(&frontmatter, &selection(&frontmatter, fake, "views: []\n")));
    }

    #[test]
    fn commonmark_normalization_accepts_crlf_indentation_and_long_tilde_fences() {
        let block = "  ~~~~base\r\n  views: []\r\n  ~~~~~";
        let note = format!("é\r\n\r\n{block}\r\n");
        assert!(verify_inline_base_source(&note, &selection(&note, block, "views: []\n")));
        let wrong_language = "```yaml\nviews: []\n```";
        assert!(!verify_inline_base_source(wrong_language, &selection(wrong_language, wrong_language, "views: []\n")));
        let nested = "> - ```base\n>   views: []\n>   ```";
        assert!(verify_inline_base_source(nested, &selection(nested, nested, "views: []\n")));
        let fake_close = "```base\nviews: []\ntext```";
        assert!(!verify_inline_base_source(fake_close, &selection(fake_close, fake_close, "views: []\ntext```")));
    }
}
