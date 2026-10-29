//! The shipping export's saved settings (`shipping_export_config`, one row keyed `default`,
//! `settings_json`): the sender, how each kind of package is sized and labeled, and the label
//! defaults. The Node shipping export reads the same JSON, so it keeps the React app's camelCase
//! shape, and a key a row lacks takes its default, as the React app's merge did.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{config, database::Database};

const CONFIG_KEY: &str = "default";

/// Postage paper. A letter's label is the 7x3 kind that fits a #10 envelope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, corten::UrlValue)]
pub enum LabelSize {
    #[serde(rename = "4x6")]
    FourBySix,
    #[serde(rename = "7x3")]
    SevenByThree,
    #[serde(rename = "6x4")]
    SixByFour,
}

impl LabelSize {
    pub const ALL: [LabelSize; 3] = [
        LabelSize::FourBySix,
        LabelSize::SevenByThree,
        LabelSize::SixByFour,
    ];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, corten::UrlValue)]
pub enum LabelFormat {
    #[serde(rename = "PDF")]
    Pdf,
    #[serde(rename = "PNG")]
    Png,
}

impl LabelFormat {
    pub const ALL: [LabelFormat; 2] = [LabelFormat::Pdf, LabelFormat::Png];
}

/// The USPS service an expedited order ships with. `First` is EasyPost's too, for a letter, but
/// not a choice here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, corten::UrlValue)]
pub enum Service {
    First,
    GroundAdvantage,
    Priority,
    Express,
}

impl Service {
    pub const EXPEDITED: [Service; 3] = [
        Service::GroundAdvantage,
        Service::Priority,
        Service::Express,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Service::First => "First",
            Service::GroundAdvantage => "Ground Advantage",
            Service::Priority => "Priority",
            Service::Express => "Express",
        }
    }
}

/// Which EasyPost account buys postage. It follows the deployment: development buys test
/// postage, production real postage, whatever a row says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EasyPostMode {
    Test,
    Production,
}

impl EasyPostMode {
    pub fn of_deployment() -> Self {
        if config::production() {
            EasyPostMode::Production
        } else {
            EasyPostMode::Test
        }
    }

    /// The environment variable that holds this mode's API key.
    pub fn key_name(self) -> &'static str {
        match self {
            EasyPostMode::Test => "EASYPOST_TEST_API_KEY",
            EasyPostMode::Production => "EASYPOST_PRODUCTION_API_KEY",
        }
    }

    pub fn has_key(self) -> bool {
        config::is_set(self.key_name())
    }
}

/// An address as EasyPost takes it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Address {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub street1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub street2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
}

impl Default for Address {
    fn default() -> Self {
        Address {
            name: String::new(),
            company: None,
            phone: None,
            email: None,
            street1: String::new(),
            street2: None,
            city: String::new(),
            state: String::new(),
            zip: String::new(),
            country: "US".into(),
        }
    }
}

/// How one kind of package is labeled, weighed and measured. A letter or a flat holds an order
/// only up to its item count and value; a parcel holds anything.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub label_size: LabelSize,
    pub base_weight_oz: f64,
    pub per_item_weight_oz: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_item_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value_usd: Option<f64>,
    pub length_in: f64,
    pub width_in: f64,
    pub height_in: f64,
}

/// What the default packages are made of, in ounces.
mod oz {
    pub const SLEEVED_CARD: f64 = 0.09;
    pub const NO_10_ENVELOPE: f64 = 0.2;
    pub const TEAM_BAG: f64 = 0.03;
    pub const PACKING_SLIP: f64 = 0.08;
    pub const BUBBLE_MAILER_5X7: f64 = 0.3;
    pub const BUBBLE_MAILER_7X9: f64 = 0.45;
    pub const RACK_CARD: f64 = 0.18;
    pub const BINDER_PAGE: f64 = 0.14;
    pub const LETTER_PAPER: f64 = 0.2;
}

impl Package {
    pub fn default_letter() -> Self {
        Package {
            label_size: LabelSize::SevenByThree,
            base_weight_oz: oz::NO_10_ENVELOPE + oz::RACK_CARD + oz::BINDER_PAGE + oz::PACKING_SLIP,
            per_item_weight_oz: oz::SLEEVED_CARD,
            max_item_count: Some(24.0),
            max_value_usd: Some(50.0),
            length_in: 9.0,
            width_in: 4.0,
            height_in: 0.25,
        }
    }

    pub fn default_flat() -> Self {
        Package {
            label_size: LabelSize::FourBySix,
            base_weight_oz: oz::BUBBLE_MAILER_5X7 + oz::TEAM_BAG * 2.0 + oz::PACKING_SLIP,
            per_item_weight_oz: oz::SLEEVED_CARD,
            max_item_count: Some(100.0),
            max_value_usd: Some(50.0),
            length_in: 5.0,
            width_in: 7.0,
            height_in: 0.75,
        }
    }

    pub fn default_parcel() -> Self {
        Package {
            label_size: LabelSize::FourBySix,
            base_weight_oz: oz::BUBBLE_MAILER_7X9
                + oz::TEAM_BAG * 4.0
                + oz::LETTER_PAPER
                + oz::PACKING_SLIP,
            per_item_weight_oz: oz::SLEEVED_CARD,
            max_item_count: None,
            max_value_usd: None,
            length_in: 7.0,
            width_in: 9.0,
            height_in: 0.75,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingConfig {
    /// The seller whose live orders the export loads unless told another; empty asks each time.
    pub default_seller_key: String,
    pub from_address: Address,
    pub letter: Package,
    pub flat: Package,
    pub parcel: Package,
    pub label_format: LabelFormat,
    /// Whether orders to the same address ship as one package.
    pub combine_orders: bool,
    pub expedited_service: Service,
    pub easypost_mode: EasyPostMode,
}

impl Default for ShippingConfig {
    fn default() -> Self {
        ShippingConfig {
            default_seller_key: String::new(),
            from_address: Address::default(),
            letter: Package::default_letter(),
            flat: Package::default_flat(),
            parcel: Package::default_parcel(),
            label_format: LabelFormat::Pdf,
            combine_orders: true,
            expedited_service: Service::GroundAdvantage,
            easypost_mode: EasyPostMode::of_deployment(),
        }
    }
}

/// `stored`'s keys over `defaults`', and an object's keys over the default object's one level
/// down: what the React app's `mergeShippingExportConfigWithDefaults` gives.
fn merged(stored: &Value) -> ShippingConfig {
    let fallback = ShippingConfig::default();
    let Value::Object(mut base) = serde_json::to_value(&fallback).expect("the defaults serialize")
    else {
        unreachable!("a struct serializes as an object")
    };
    if let Value::Object(top) = stored {
        for (key, value) in top {
            match (base.get_mut(key), value) {
                (Some(Value::Object(inner)), Value::Object(over)) => {
                    inner.extend(over.iter().map(|(k, v)| (k.clone(), v.clone())))
                }
                _ => {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
    }
    let config: ShippingConfig = serde_json::from_value(Value::Object(base)).unwrap_or(fallback);
    ShippingConfig {
        easypost_mode: EasyPostMode::of_deployment(),
        ..config
    }
}

pub async fn load(db: &Database) -> sqlx::Result<ShippingConfig> {
    let stored: Option<Value> = sqlx::query_scalar(
        "SELECT settings_json FROM shipping_export_config WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .fetch_optional(&db.0)
    .await?;
    Ok(merged(&stored.unwrap_or(Value::Null)))
}

pub async fn save(db: &Database, config: &ShippingConfig) -> sqlx::Result<()> {
    let config = ShippingConfig {
        easypost_mode: EasyPostMode::of_deployment(),
        ..config.clone()
    };
    sqlx::query(
        "INSERT INTO shipping_export_config (config_key, settings_json, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (config_key) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()",
    )
    .bind(CONFIG_KEY)
    .bind(serde_json::to_value(&config).expect("the settings serialize"))
    .execute(&db.0)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_stored_row_keeps_its_values_and_takes_defaults_for_what_it_lacks() {
        let stored = json!({
            "defaultSellerKey": "8520a14f",
            "fromAddress": { "name": "Shop", "street1": "PO BOX 1", "city": "MAIZE", "state": "KS", "zip": "67101" },
            "letter": { "maxItemCount": 30 },
            "easypostMode": "production",
        });
        let config = merged(&stored);
        assert_eq!(config.default_seller_key, "8520a14f");
        assert_eq!(
            (
                config.from_address.country.as_str(),
                config.from_address.company.as_deref()
            ),
            ("US", None)
        );
        assert_eq!(config.letter.max_item_count, Some(30.0));
        assert_eq!(config.letter.label_size, LabelSize::SevenByThree);
        assert_eq!(config.parcel, Package::default_parcel());
        assert_eq!(
            config.easypost_mode,
            EasyPostMode::of_deployment(),
            "the deployment decides the mode"
        );
    }

    #[test]
    fn the_json_keeps_the_react_apps_names() {
        let value = serde_json::to_value(ShippingConfig::default()).unwrap();
        assert_eq!(value["letter"]["labelSize"], json!("7x3"));
        assert_eq!(value["labelFormat"], json!("PDF"));
        assert_eq!(value["expeditedService"], json!("GroundAdvantage"));
        assert!(
            value["parcel"].get("maxItemCount").is_none(),
            "a parcel has no limit"
        );
        assert!(
            value["fromAddress"].get("company").is_none(),
            "an empty optional is left out"
        );
        assert!((value["letter"]["baseWeightOz"].as_f64().unwrap() - 0.6).abs() < 1e-9);
    }
}
