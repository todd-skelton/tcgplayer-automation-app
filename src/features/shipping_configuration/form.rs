//! The settings form as the browser sends it. The sender is a group of fields (`from.city`), and
//! each package is one group type drawn three times (`letter.length_in`, `flat.length_in`, ..).
use corten::prelude::*;

use super::config::{Address, LabelFormat, LabelSize, Package, Service, ShippingConfig};

#[derive(Clone, Debug, Fields)]
pub struct SettingsInput {
    pub default_seller_key: String,
    #[fields(group)]
    pub from: AddressInput,
    #[fields(group)]
    pub letter: PackageInput,
    #[fields(group)]
    pub flat: PackageInput,
    #[fields(group)]
    pub parcel: PackageInput,
    pub label_format: LabelFormat,
    pub expedited_service: Service,
    #[serde(default)]
    pub combine_orders: bool,
}

/// The sender's address, as text.
#[derive(Clone, Debug, Fields)]
pub struct AddressInput {
    pub name: String,
    pub company: String,
    pub phone: String,
    pub email: String,
    pub street1: String,
    pub street2: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
}

/// One package's inputs, as typed. A parcel has no limits, so its form sends none and they stay
/// blank.
#[derive(Clone, Debug, Fields)]
pub struct PackageInput {
    pub label_size: LabelSize,
    pub base_weight_oz: Entry<f64>,
    pub per_item_weight_oz: Entry<f64>,
    #[serde(default)]
    pub max_item_count: Entry<f64>,
    #[serde(default)]
    pub max_value_usd: Entry<f64>,
    pub length_in: Entry<f64>,
    pub width_in: Entry<f64>,
    pub height_in: Entry<f64>,
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

    /// Whether the package has an item count and value limit.
    pub fn limited(self) -> bool {
        self != Kind::Parcel
    }

    /// The package's fields in the form.
    pub fn fields(self) -> PackageInputGroupFields {
        let f = SettingsInput::FIELDS;
        match self {
            Kind::Letter => f.letter,
            Kind::Flat => f.flat,
            Kind::Parcel => f.parcel,
        }
    }
}

/// A measure as the form shows it, to six places: `0.6`, not `0.6000000000000001`.
pub fn measure(n: f64) -> Entry<f64> {
    ((n * 1e6).round() / 1e6).into()
}

fn optional(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

impl PackageInput {
    fn of(package: &Package, limited: bool) -> Self {
        let limit = |n: Option<f64>| match limited {
            true => measure(n.unwrap_or(0.0)),
            false => Entry::default(),
        };
        PackageInput {
            label_size: package.label_size,
            base_weight_oz: measure(package.base_weight_oz),
            per_item_weight_oz: measure(package.per_item_weight_oz),
            max_item_count: limit(package.max_item_count),
            max_value_usd: limit(package.max_value_usd),
            length_in: measure(package.length_in),
            width_in: measure(package.width_in),
            height_in: measure(package.height_in),
        }
    }

    /// The package the inputs say; a measure that is not a number of at least zero, blank
    /// included, is an error on its own input.
    fn read(&self, kind: Kind, errors: &mut Errors) -> Package {
        let f = kind.fields();
        let mut number = |field, entry: &Entry<f64>, what: &str| -> f64 {
            match entry.value() {
                Some(n) if n >= 0.0 => n,
                _ => {
                    errors.add(
                        field,
                        format!("{}: {what} must be a number of at least 0.", kind.name()),
                    );
                    0.0
                }
            }
        };
        let base_weight_oz = number(f.base_weight_oz, &self.base_weight_oz, "the base weight");
        let per_item_weight_oz = number(
            f.per_item_weight_oz,
            &self.per_item_weight_oz,
            "the per item weight",
        );
        let limits = kind.limited().then(|| {
            (
                number(f.max_item_count, &self.max_item_count, "the max item count"),
                number(f.max_value_usd, &self.max_value_usd, "the max value"),
            )
        });
        Package {
            label_size: self.label_size,
            base_weight_oz,
            per_item_weight_oz,
            max_item_count: limits.map(|(count, _)| count),
            max_value_usd: limits.map(|(_, value)| value),
            length_in: number(f.length_in, &self.length_in, "the length"),
            width_in: number(f.width_in, &self.width_in, "the width"),
            height_in: number(f.height_in, &self.height_in, "the height"),
        }
    }
}

impl SettingsInput {
    /// The form filled with `config`.
    pub fn of(config: &ShippingConfig) -> Self {
        let a = &config.from_address;
        SettingsInput {
            default_seller_key: config.default_seller_key.clone(),
            from: AddressInput {
                name: a.name.clone(),
                company: a.company.clone().unwrap_or_default(),
                phone: a.phone.clone().unwrap_or_default(),
                email: a.email.clone().unwrap_or_default(),
                street1: a.street1.clone(),
                street2: a.street2.clone().unwrap_or_default(),
                city: a.city.clone(),
                state: a.state.clone(),
                zip: a.zip.clone(),
                country: a.country.clone(),
            },
            letter: PackageInput::of(&config.letter, true),
            flat: PackageInput::of(&config.flat, true),
            parcel: PackageInput::of(&config.parcel, false),
            label_format: config.label_format,
            expedited_service: config.expedited_service,
            combine_orders: config.combine_orders,
        }
    }

    pub fn package(&self, kind: Kind) -> &PackageInput {
        match kind {
            Kind::Letter => &self.letter,
            Kind::Flat => &self.flat,
            Kind::Parcel => &self.parcel,
        }
    }

    /// The settings the form says, or why it does not say any.
    pub fn read(&self) -> Result<ShippingConfig, Errors> {
        let mut errors = Errors::new();
        let letter = self.letter.read(Kind::Letter, &mut errors);
        let flat = self.flat.read(Kind::Flat, &mut errors);
        let parcel = self.parcel.read(Kind::Parcel, &mut errors);
        let a = &self.from;
        let config = ShippingConfig {
            default_seller_key: self.default_seller_key.trim().to_string(),
            from_address: Address {
                name: a.name.trim().to_string(),
                company: optional(&a.company),
                phone: optional(&a.phone),
                email: optional(&a.email),
                street1: a.street1.trim().to_string(),
                street2: optional(&a.street2),
                city: a.city.trim().to_string(),
                state: a.state.trim().to_string(),
                zip: a.zip.trim().to_string(),
                country: optional(&a.country).unwrap_or_else(|| "US".into()),
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
        input.flat.width_in = Entry::typed("wide");
        let errors = input.read().unwrap_err();
        assert!(!errors.has(SettingsInput::FIELDS.letter.width_in));
        assert_eq!(
            errors.get(SettingsInput::FIELDS.flat.width_in),
            Some("Flat: the width must be a number of at least 0.")
        );
    }

    #[test]
    fn blank_optional_address_lines_are_left_out() {
        let mut input = SettingsInput::of(&ShippingConfig::default());
        input.from.company = "  ".into();
        input.from.country = String::new();
        let address = input.read().unwrap().from_address;
        assert_eq!((address.company, address.country.as_str()), (None, "US"));
    }
}
