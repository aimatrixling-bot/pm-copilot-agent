// Group chat history buffer
// Stores recent messages from non-triggered group conversations so the bot has context
// when it is eventually @mentioned.

use std::collections::{HashMap, VecDeque};

/// Maximum messages to keep per group
const MAX_PER_GROUP: usize = 30;
/// Maximum number of groups to track
const MAX_GROUPS: usize = 500;
/// Maximum text length per entry (truncated)
const MAX_TEXT_LENGTH: usize = 200;

/// A single history entry from a group conversation
#[derive(Debug, Clone)]
pub struct GroupHistoryEntry {
    pub sender_name: String,
    pub text: String,
    /// Wall-clock timestamp for display in AI context (year-month-day hour:minute:second)
    pub timestamp: chrono::DateTime<chrono::Local>,
}

/// Buffers recent group messages that didn't trigger the bot.
/// When the bot is @mentioned, pending history is drained and injected as context.
pub struct GroupHistoryBuffer {
    history: HashMap<String, VecDeque<GroupHistoryEntry>>,
}

impl GroupHistoryBuffer {
    pub fn new() -> Self {
        Self {
            history: HashMap::new(),
        }
    }

    /// Push a new entry into the buffer for the given session_key.
    /// Automatically truncates text and enforces per-group and global limits.
    pub fn push(&mut self, session_key: &str, entry: GroupHistoryEntry) {
        // Enforce global group limit (evict oldest-access group)
        if !self.history.contains_key(session_key) && self.history.len() >= MAX_GROUPS {
            // Find group with oldest last entry
            let oldest_key = self
                .history
                .iter()
                .filter_map(|(k, q)| q.back().map(|e| (k.clone(), e.timestamp)))
                .min_by_key(|(_, ts)| *ts)
                .map(|(k, _)| k);
            if let Some(key) = oldest_key {
                self.history.remove(&key);
            }
        }

        let queue = self.history.entry(session_key.to_string()).or_default();

        // Truncate text
        let text = if entry.text.len() > MAX_TEXT_LENGTH {
            let truncate_at = entry
                .text
                .char_indices()
                .nth(MAX_TEXT_LENGTH)
                .map(|(i, _)| i)
                .unwrap_or(entry.text.len());
            format!("{}…", &entry.text[..truncate_at])
        } else {
            entry.text
        };

        queue.push_back(GroupHistoryEntry {
            sender_name: entry.sender_name,
            text,
            timestamp: entry.timestamp,
        });

        // Enforce per-group limit
        while queue.len() > MAX_PER_GROUP {
            queue.pop_front();
        }
    }

    /// Drain all buffered entries for a session_key, returning them in chronological order.
    /// The buffer for this key is cleared after draining.
    pub fn drain(&mut self, session_key: &str) -> Vec<GroupHistoryEntry> {
        self.history
            .remove(session_key)
            .map(|q| q.into_iter().collect())
            .unwrap_or_default()
    }

    /// Clear buffer for a specific session_key.
    pub fn clear(&mut self, session_key: &str) {
        self.history.remove(session_key);
    }

    /// Format drained history as a context string for the AI.
    pub fn format_as_context(entries: &[GroupHistoryEntry]) -> Option<String> {
        if entries.is_empty() {
            return None;
        }
        let mut lines = vec!["[以下是上次回复后的群聊记录，仅供参考]".to_string()];
        for entry in entries {
            let ts = entry.timestamp.format("%Y-%m-%d %H:%M:%S");
            lines.push(format!("[from: {} {}] {}", entry.sender_name, ts, entry.text));
        }
        lines.push("[以下是当前消息，请回复]".to_string());
        Some(lines.join("\n"))
    }
}
