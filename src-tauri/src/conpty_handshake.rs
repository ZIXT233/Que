//! Answer the bundled ConPTY host's initial DA1 before a frontend attaches.
//! Only recognize its exact startup prefix. Later CLI queries and replayed
//! output must not cause unsolicited input in an application's prompt.
#[derive(Default)]
pub struct StartupHandshake {
    matched: usize,
    finished: bool,
}

impl StartupHandshake {
    pub fn feed(&mut self, bytes: &[u8]) -> Option<&'static [u8]> {
        const PREFIX: &[u8] = b"\x1b[1t\x1b[c";
        if self.finished {
            return None;
        }
        for &byte in bytes {
            if byte != PREFIX[self.matched] {
                self.finished = true;
                return None;
            }
            self.matched += 1;
            if self.matched == PREFIX.len() {
                self.finished = true;
                return Some(b"\x1b[?1;2c");
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_once_across_every_chunk_boundary() {
        let prefix = b"\x1b[1t\x1b[c";
        for split in 0..prefix.len() {
            let mut handshake = StartupHandshake::default();
            assert_eq!(handshake.feed(&prefix[..split]), None);
            assert_eq!(
                handshake.feed(&prefix[split..]),
                Some(b"\x1b[?1;2c".as_slice())
            );
            assert_eq!(handshake.feed(prefix), None);
        }
    }

    #[test]
    fn leaves_application_output_and_later_queries_alone() {
        for first in [b"hello".as_slice(), b"\x1b[c", b"\x1b[1tX"] {
            let mut handshake = StartupHandshake::default();
            assert_eq!(handshake.feed(first), None);
            assert_eq!(handshake.feed(b"\x1b[1t\x1b[c"), None);
        }
    }

    #[test]
    fn handles_coalesced_startup_modes() {
        let mut handshake = StartupHandshake::default();
        assert_eq!(
            handshake.feed(b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h"),
            Some(b"\x1b[?1;2c".as_slice())
        );
    }
}
