//! One file per harness, each owning everything about that harness: how it is launched,
//! which hooks it is asked to report, how its hook config is written, what its session
//! store can answer, and its private quirks.
//!
//! Only what two or more harnesses share lives outside these files — the mechanics of
//! getting files onto a machine and naming the ingress (`super::install`), and the JSON
//! config inheritance they all lean on (`super::inherited`).
//!
//! The `use` bindings below let a kind file reach the harness module's shared pieces
//! with `super::…`, so the files read exactly as they did when they sat one level up.

use crate::harness::{
    debug, inherited, install, label_text, registry, session_find, session_label, signals,
};

pub(super) mod antigravity;
pub(super) mod claude;
pub(super) mod codebuddy;
pub(super) mod codex;
pub(super) mod cursor;
pub(super) mod devin;
pub(super) mod grok;
pub(super) mod opencode;
pub(super) mod pi;
pub(super) mod shell;
