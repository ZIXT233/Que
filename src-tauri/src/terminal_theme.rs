use std::sync::atomic::{AtomicBool, Ordering};

static APP_DARK: AtomicBool = AtomicBool::new(false);

pub fn set_app_dark(dark: bool) {
    APP_DARK.store(dark, Ordering::Relaxed);
}

pub fn app_dark() -> bool {
    APP_DARK.load(Ordering::Relaxed)
}

/// rxvt COLORFGBG: background ≥ 8 is treated as a light terminal.
///
/// Pushed through the spawn environment, not a query reply — xterm cannot supply
/// it, which is why this stayed in the backend after the query responders moved.
pub fn colorfgbg(dark: bool) -> &'static str {
    if dark {
        "15;0"
    } else {
        "0;15"
    }
}

pub fn is_dark_colorfgbg(value: &str) -> bool {
    value
        .split(';')
        .nth(1)
        .and_then(|bg| bg.parse::<u8>().ok())
        .is_some_and(|bg| bg < 8)
}

/// Incremental DECSET/DECRST 2031 observer. PTY reads can split any escape
/// sequence; control strings (titles, clipboard, DCS) must not arm reports.
#[derive(Default)]
pub struct ThemeNotifyParser {
    state: u8, // 0 text, 1 ESC, 2 CSI, 3 control string, 4 string ESC
    csi: Vec<u8>,
    string_is_osc: bool,
}

impl ThemeNotifyParser {
    pub fn feed(&mut self, bytes: &[u8]) -> Option<bool> {
        let mut change = None;
        for &byte in bytes {
            match self.state {
                3 | 4 => {
                    self.state = if (byte == 7 && self.string_is_osc)
                        || byte == 24
                        || byte == 26
                        || (self.state == 4 && byte == b'\\')
                    {
                        0
                    } else if byte == 27 {
                        4
                    } else {
                        3
                    };
                }
                1 => {
                    self.state = match byte {
                        b'[' => {
                            self.csi.clear();
                            2
                        }
                        b']' | b'P' | b'X' | b'^' | b'_' => {
                            self.string_is_osc = byte == b']';
                            3
                        }
                        27 => 1,
                        _ => 0,
                    };
                }
                2 => {
                    if (0x40..=0x7e).contains(&byte) {
                        if (byte == b'h' || byte == b'l')
                            && self.csi.first() == Some(&b'?')
                            && self.csi[1..]
                                .split(|b| *b == b';')
                                .any(|mode| mode == b"2031")
                        {
                            change = Some(byte == b'h');
                        }
                        self.state = 0;
                        self.csi.clear();
                    } else if byte == 27 || byte == 24 || byte == 26 || self.csi.len() >= 128 {
                        self.state = if byte == 27 { 1 } else { 0 };
                        self.csi.clear();
                    } else {
                        self.csi.push(byte);
                    }
                }
                _ => {
                    if byte == 27 {
                        self.state = 1;
                    }
                }
            }
        }
        change
    }
}

/// Mode 2031: 1 = became dark, 2 = became light. Prompts a new OSC 10/11 probe.
pub fn theme_change_report(dark: bool) -> &'static str {
    if dark {
        "\x1b[?997;1n"
    } else {
        "\x1b[?997;2n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_colorfgbg_is_the_rxvt_light_pair() {
        assert_eq!(colorfgbg(false), "0;15");
        assert!(!is_dark_colorfgbg("0;15"));
        assert!(is_dark_colorfgbg("15;0"));
    }

    #[test]
    fn theme_notify_tracks_decset_2031() {
        let mut parser = ThemeNotifyParser::default();
        assert_eq!(parser.feed(b"\x1b[?2031h"), Some(true));
        assert_eq!(parser.feed(b"\x1b[?1004;2031h"), Some(true));
        assert_eq!(parser.feed(b"\x1b[?2031l"), Some(false));
        assert_eq!(theme_change_report(true), "\x1b[?997;1n");
        assert_eq!(theme_change_report(false), "\x1b[?997;2n");
    }

    #[test]
    fn theme_notify_survives_every_read_boundary() {
        for sequence in [b"\x1b[?1004;2031h".as_slice(), b"\x1b[?2031l".as_slice()] {
            for split in 0..=sequence.len() {
                let mut parser = ThemeNotifyParser::default();
                let first = parser.feed(&sequence[..split]);
                let last = parser.feed(&sequence[split..]);
                assert_eq!(last.or(first), Some(sequence.last() == Some(&b'h')));
            }
        }
    }

    #[test]
    fn theme_notify_ignores_strings_and_other_modes() {
        let mut parser = ThemeNotifyParser::default();
        for byte in b"\x1b]0;title \x1b[?2031h\x1b\\\x1bP\x07\x1b[?2031h\x1b\\\x1b[?12031h" {
            assert_eq!(parser.feed(&[*byte]), None);
        }
        assert_eq!(parser.feed(b"\x1b[?2031h\x1b[?2031l"), Some(false));
    }
}
