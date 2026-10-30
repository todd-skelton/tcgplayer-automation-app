//! The settings form as the browser sends it. `Fields` cannot nest a group of fields
//! (corten#363), so the sender's fields are `from_*` and each package's are `letter_*`,
//! `flat_*` and `parcel_*`; [`PackageNames`] gathers one package's names for the view and the
//! reader, which is what `FIELDS.letter` would be.
use corten::prelude::*;
use serde::Deserialize;

use super::config::{Address, LabelFormat, LabelSize, Package, Service, ShippingConfig};

#[derive(Clone, Debug, Deserialize, Fields)]
pub struct SettingsInput {
    pub default_seller_key: String,
    pub from_name: String,
    pub from_company: String,
    pub from_phone: String,
    pub from_email: String,
    pub from_street1: String,
    pub from_street2: String,
    pub from_city: String,
    pub from_state: String,
    pub from_zip: String,
    pub from_country: String,
    pub letter_label_size: LabelSize,
    pub letter_base_weight_oz: String,
    pub letter_per_item_weight_oz: String,
    pub letter_max_item_count: String,
    pub letter_max_value_usd: String,
    pub letter_length_in: String,
    pub letter_width_in: String,
    pub letter_height_in: String,
    pub flat_label_size: LabelSize,
    pub flat_base_weight_oz: String,
    pub flat_per_item_weight_oz: String,
    pub flat_max_item_count: String,
    pub flat_max_value_usd: String,
    pub flat_length_in: String,
    pub flat_width_in: String,
    pub flat_height_in: String,
    pub parcel_label_size: LabelSize,
    pub parcel_base_weight_oz: String,
    pub parcel_per_item_weight_oz: String,
    pub parcel_length_in: String,
    pub parcel_width_in: String,
    pub parcel_height_in: String,
    pub label_format: LabelFormat,
    pub expedited_service: Service,
    #[serde(default)]
    pub combine_orders: bool,
}

/// A kind of package, each with its own block of the form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Letter,
    Flat,
    Parcel,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Letter, Kind::Flat, Kind::Parcel];

    pub fn title(self) -> &'static str {
        match self {
            Kind::Letter => "Letter Settings",
            Kind::Flat => "Flat Settings",
            Kind::Parcel => "Parcel Settings",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Letter => "Letter",
            Kind::Flat => "Flat",
            Kind::Parcel => "Parcel",
        }
    }
}

/// One package's field names. A parcel has no limits.
#[derive(Clone, Copy)]
pub struct PackageNames {
    pub label_size: FieldName,
    pub base_weight_oz: FieldName,
    pub per_item_weight_oz: FieldName,
    pub limits: Option<(FieldName, FieldName)>,
    pub length_in: FieldName,
    pub width_in: FieldName,
    pub height_in: FieldName,
}

/// One package's inputs as text: what they show.
#[derive(Clone, Copy)]
pub struct PackageText<'a> {
    pub label_size: LabelSize,
    pub base_weight_oz: &'a str,
    pub per_item_weight_oz: &'a str,
    pub limits: Option<(&'a str, &'a str)>,
    pub length_in: &'a str,
    pub width_in: &'a str,
    pub height_in: &'a str,
}

impl PackageNames {
    pub fn of(kind: Kind) -> Self {
        let f = SettingsInput::FIELDS;
        match kind {
            Kind::Letter => PackageNames {
                label_size: f.letter_label_size,
                base_weight_oz: f.letter_base_weight_oz,
                per_item_weight_oz: f.letter_per_item_weight_oz,
                limits: Some((f.letter_max_item_count, f.letter_max_value_usd)),
                length_in: f.letter_length_in,
                width_in: f.letter_width_in,
                height_in: f.letter_height_in,
            },
            Kind::Flat => PackageNames {
                label_size: f.flat_label_size,
                base_weight_oz: f.flat_base_weight_oz,
                per_item_weight_oz: f.flat_per_item_weight_oz,
                limits: Some((f.flat_max_item_count, f.flat_max_value_usd)),
                length_in: f.flat_length_in,
                width_in: f.flat_width_in,
                height_in: f.flat_height_in,
            },
            Kind::Parcel => PackageNames {
                label_size: f.parcel_label_size,
                base_weight_oz: f.parcel_base_weight_oz,
                per_item_weight_oz: f.parcel_per_item_weight_oz,
                limits: None,
                length_in: f.parcel_length_in,
                width_in: f.parcel_width_in,
                height_in: f.parcel_height_in,
            },
        }
    }
}

/// A number as the form shows it: `0.6`, not `0.6000000000000001`.
pub fn measure_text(n: f64) -> String {
    let rounded = (n * 1e6).round() / 1e6;
    rounded.to_string()
}

fn optional(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

impl SettingsInput {
    /// The form filled with `config`.
    pub fn of(config: &ShippingConfig) -> Self {
        let a = &config.from_address;
        let (l, fl, p) = (&config.letter, &config.flat, &config.parcel);
        let limit = |n: Option<f64>| measure_text(n.unwrap_or(0.0));
        SettingsInput {
            default_seller_key: config.default_seller_key.clone(),
            from_name: a.name.clone(),
            from_company: a.company.clone().unwrap_or_default(),
            from_phone: a.phone.clone().unwrap_or_default(),
            from_email: a.email.clone().unwrap_or_default(),
            from_street1: a.street1.clone(),
            from_street2: a.street2.clone().unwrap_or_default(),
            from_city: a.city.clone(),
            from_state: a.state.clone(),
            from_zip: a.zip.clone(),
            from_country: a.country.clone(),
            letter_label_size: l.label_size,
            letter_base_weight_oz: measure_text(l.base_weight_oz),
            letter_per_item_weight_oz: measure_text(l.per_item_weight_oz),
            letter_max_item_count: limit(l.max_item_count),
            letter_max_value_usd: limit(l.max_value_usd),
            letter_length_in: measure_text(l.length_in),
            letter_width_in: measure_text(l.width_in),
            letter_height_in: measure_text(l.height_in),
            flat_label_size: fl.label_size,
            flat_base_weight_oz: measure_text(fl.base_weight_oz),
            flat_per_item_weight_oz: measure_text(fl.per_item_weight_oz),
            flat_max_item_count: limit(fl.max_item_count),
            flat_max_value_usd: limit(fl.max_value_usd),
            flat_length_in: measure_text(fl.length_in),
            flat_width_in: measure_text(fl.width_in),
            flat_height_in: measure_text(fl.height_in),
            parcel_label_size: p.label_size,
            parcel_base_weight_oz: measure_text(p.base_weight_oz),
            parcel_per_item_weight_oz: measure_text(p.per_item_weight_oz),
            parcel_length_in: measure_text(p.length_in),
            parcel_width_in: measure_text(p.width_in),
            parcel_height_in: measure_text(p.height_in),
            label_format: config.label_format,
            expedited_service: config.expedited_service,
            combine_orders: config.combine_orders,
        }
    }

    pub fn package(&self, kind: Kind) -> PackageText<'_> {
        match kind {
            Kind::Letter => PackageText {
                label_size: self.letter_label_size,
                base_weight_oz: &self.letter_base_weight_oz,
                per_item_weight_oz: &self.letter_per_item_weight_oz,
                limits: Some((&self.letter_max_item_count, &self.letter_max_value_usd)),
                length_in: &self.letter_length_in,
                width_in: &self.letter_width_in,
                height_in: &self.letter_height_in,
            },
            Kind::Flat => PackageText {
                label_size: self.flat_label_size,
                base_weight_oz: &self.flat_base_weight_oz,
                per_item_weight_oz: &self.flat_per_item_weight_oz,
                limits: Some((&self.flat_max_item_count, &self.flat_max_value_usd)),
                length_in: &self.flat_length_in,
                width_in: &self.flat_width_in,
                height_in: &self.flat_height_in,
            },
            Kind::Parcel => PackageText {
                label_size: self.parcel_label_size,
                base_weight_oz: &self.parcel_base_weight_oz,
                per_item_weight_oz: &self.parcel_per_item_weight_oz,
                limits: None,
                length_in: &self.parcel_length_in,
                width_in: &self.parcel_width_in,
                height_in: &self.parcel_height_in,
            },
        }
    }

    /// The settings the form says, or why it does not say any. Every measure is a number of at
    /// least zero; the React app saved whatever `Number()` made of it, blanks as 0.
    pub fn read(&self) -> Result<ShippingConfig, Errors> {
        let mut errors = Errors::new();
        let mut package =
            |kind: Kind| -> Package {
                let (names, text) = (PackageNames::of(kind), self.package(kind));
                let mut number = |field: FieldName, text: &str, what: &str| -> f64 {
                    match text.trim().parse::<f64>() {
                        Ok(n) if n.is_finite() && n >= 0.0 => n,
                        _ => {
                            errors.add(
                                field,
                                format!("{}: {what} must be a number of at least 0.", kind.name()),
                            );
                            0.0
                        }
                    }
                };
                let base_weight_oz =
                    number(names.base_weight_oz, text.base_weight_oz, "the base weight");
                let per_item_weight_oz = number(
                    names.per_item_weight_oz,
                    text.per_item_weight_oz,
                    "the per item weight",
                );
                let limits = names.limits.zip(text.limits).map(
                    |((count_name, value_name), (count, value))| {
                        (
                            number(count_name, count, "the max item count"),
                            number(value_name, value, "the max value"),
                        )
                    },
                );
                Package {
                    label_size: text.label_size,
                    base_weight_oz,
                    per_item_weight_oz,
                    max_item_count: limits.map(|(count, _)| count),
                    max_value_usd: limits.map(|(_, value)| value),
                    length_in: number(names.length_in, text.length_in, "the length"),
                    width_in: number(names.width_in, text.width_in, "the width"),
                    height_in: number(names.height_in, text.height_in, "the height"),
                }
            };
        let (letter, flat, parcel) = (
            package(Kind::Letter),
            package(Kind::Flat),
            package(Kind::Parcel),
        );
        let config = ShippingConfig {
            default_seller_key: self.default_seller_key.trim().to_string(),
            from_address: Address {
                name: self.from_name.trim().to_string(),
                company: optional(&self.from_company),
                phone: optional(&self.from_phone),
                email: optional(&self.from_email),
                street1: self.from_street1.trim().to_string(),
                street2: optional(&self.from_street2),
                city: self.from_city.trim().to_string(),
                state: self.from_state.trim().to_string(),
                zip: self.from_zip.trim().to_string(),
                country: optional(&self.from_country).unwrap_or_else(|| "US".into()),
            },
            letter,
            flat,
            parcel,
            label_format: self.label_format,
            combine_orders: self.combine_orders,
            expedited_service: self.expedited_service,
            ..ShippingConfig::default()
        };
        errors.into_result(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_of_the_settings_reads_back_as_them() {
        let mut config = ShippingConfig::default();
        config.from_address.name = "Pokebash TCG".into();
        config.from_address.phone = Some("+13165550100".into());
        config.letter.max_item_count = Some(30.0);
        config.combine_orders = false;
        let read = SettingsInput::of(&config).read().unwrap();
        assert_eq!(read.from_address, config.from_address);
        assert_eq!(
            (read.letter.max_item_count, read.combine_orders),
            (Some(30.0), false)
        );
        assert!((read.letter.base_weight_oz - 0.6).abs() < 1e-9);
        assert_eq!(read.parcel.max_item_count, None, "a parcel has no limit");
    }

    #[test]
    fn a_measure_that_is_not_a_number_names_its_package() {
        let mut input = SettingsInput::of(&ShippingConfig::default());
        input.flat_width_in = "wide".into();
        let errors = input.read().unwrap_err();
        assert_eq!(
            errors.get(SettingsInput::FIELDS.flat_width_in),
            Some("Flat: the width must be a number of at least 0.")
        );
    }

    #[test]
    fn blank_optional_address_lines_are_left_out() {
        let input = SettingsInput {
            from_company: "  ".into(),
            from_country: "".into(),
            ..SettingsInput::of(&ShippingConfig::default())
        };
        let address = input.read().unwrap().from_address;
        assert_eq!((address.company, address.country.as_str()), (None, "US"));
    }
}
