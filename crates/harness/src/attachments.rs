//! Files sent with a prompt. Every harness gets their paths in the prompt
//! text, so the agent can open them with its own tools; a harness whose
//! model takes images directly also sends those inline ([`load_images`]).


use base64::Engine as _;

/// The prompt when only files were sent.
pub const ATTACHMENTS_ONLY_PROMPT: &str = "See the attached files.";

/// Heads the list of paths under the prompt.
pub const ATTACHMENTS_HEADER: &str = "Attached files (local copies; open them to read):";

/// Largest image sent inline: the API's 5 MB cap once base64-encoded. A
/// bigger one is left to the path list.
pub const MAX_INLINE_IMAGE_BYTES: usize = 5 * 1024 * 1024 / 4 * 3;

/// `prompt` with the attachments' paths listed under it. Unchanged without
/// attachments.
pub fn prompt_with_attachments(prompt: &str, paths: &[String]) -> String {
    if paths.is_empty() {
        return prompt.to_owned();
    }
    let prompt = if prompt.trim().is_empty() {
        ATTACHMENTS_ONLY_PROMPT
    } else {
        prompt
    };
    let list: Vec<String> = paths.iter().map(|p| format!("- {p}")).collect();
    format!("{prompt}\n\n{ATTACHMENTS_HEADER}\n{}", list.join("\n"))
}

/// An image to send inline.
#[derive(Debug, Clone, PartialEq)]
pub struct InlineImage {
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: &'static str,
    /// Base64, no `data:` prefix.
    pub data: String,
}

/// The attachments that are images a model takes inline, best-effort: a file
/// that can't be read, is too big or isn't such an image is skipped (its path
/// is still in the prompt).
pub async fn load_images(paths: &[String]) -> Vec<InlineImage> {
    let mut images = Vec::new();
    for path in paths {
        let Ok(meta) = tokio::fs::metadata(path).await else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_INLINE_IMAGE_BYTES as u64 {
            continue;
        }
        let Ok(bytes) = tokio::fs::read(path).await else {
            continue;
        };
        let Some(media_type) = image_type(&bytes) else {
            continue;
        };
        images.push(InlineImage {
            media_type,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }
    images
}

/// An image type the API takes, by content.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_paths_under_the_prompt() {
        assert_eq!(prompt_with_attachments("hi", &[]), "hi");
        assert_eq!(
            prompt_with_attachments("look", &["/a/b.png".into(), "/c d/e.txt".into()]),
            format!("look\n\n{ATTACHMENTS_HEADER}\n- /a/b.png\n- /c d/e.txt")
        );
        assert!(prompt_with_attachments(" ", &["/x".into()]).starts_with(ATTACHMENTS_ONLY_PROMPT));
    }

    #[test]
    fn images_are_typed_by_content() {
        assert_eq!(image_type(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(image_type(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8"), Some("image/webp"));
        assert_eq!(image_type(b"<svg/>"), None);
    }

    #[tokio::test]
    async fn loads_only_readable_images() {
        let dir = std::env::temp_dir().join(format!("hive-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a.png");
        let txt = dir.join("b.txt");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(&txt, b"hello").unwrap();
        let paths = [png, txt, dir.join("missing.png")]
            .map(|p| p.display().to_string())
            .to_vec();
        let images = load_images(&paths).await;
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].media_type, "image/png");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
