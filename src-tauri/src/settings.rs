use crate::error::AppResult;
use crate::models::AppSettings;
use crate::paths::{atomic_write, settings_file};
use tokio::sync::Mutex;

pub struct SettingsStore {
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self {
            lock: Mutex::new(()),
        }
    }

    pub fn read(&self) -> AppResult<AppSettings> {
        match std::fs::read_to_string(settings_file()) {
            Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(AppSettings::default())
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn load_for_boot(&self) -> AppResult<AppSettings> {
        let path = settings_file();
        let raw = std::fs::read_to_string(&path).ok();
        let settings = self.read()?;
        let missing_key = raw.as_deref().is_none_or(|text| {
            !text.contains("developer_probes") && !text.contains("developerProbes")
        });
        if missing_key {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            atomic_write(&path, &serde_json::to_string_pretty(&settings)?)?;
        }
        crate::dev_tools::init_from_settings(settings.developer_probes);
        Ok(settings)
    }

    pub async fn set_powershell(&self, enabled: bool) -> AppResult<AppSettings> {
        let _guard = self.lock.lock().await;
        let mut settings = self.read()?;
        settings.powershell_enabled = enabled;
        atomic_write(&settings_file(), &serde_json::to_string_pretty(&settings)?)?;
        Ok(settings)
    }

    pub async fn set_debug_logging(&self, enabled: bool) -> AppResult<AppSettings> {
        let _guard = self.lock.lock().await;
        let mut settings = self.read()?;
        settings.developer_probes = enabled;
        atomic_write(&settings_file(), &serde_json::to_string_pretty(&settings)?)?;
        crate::dev_tools::init_from_settings(enabled);
        crate::debuglog::info("app", &format!("debug_logging={}", enabled));
        Ok(settings)
    }

    pub async fn set_external_ingress(
        &self,
        harness: &str,
        enabled: bool,
    ) -> AppResult<AppSettings> {
        let _guard = self.lock.lock().await;
        let mut settings = self.read()?;
        settings
            .external_ingress
            .insert(harness.to_string(), enabled);
        atomic_write(&settings_file(), &serde_json::to_string_pretty(&settings)?)?;
        crate::debuglog::info("app", &format!("external_ingress[{}]={}", harness, enabled));
        Ok(settings)
    }

    pub async fn set_external_notices(&self, enabled: bool) -> AppResult<AppSettings> {
        let _guard = self.lock.lock().await;
        let mut settings = self.read()?;
        settings.external_notices_enabled = enabled;
        atomic_write(&settings_file(), &serde_json::to_string_pretty(&settings)?)?;
        crate::debuglog::info("app", &format!("external_notices={}", enabled));
        Ok(settings)
    }
}
