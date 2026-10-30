//! The packages a batch of orders ships as, built from the orders and the shipping settings
//! (ported from `services/shippingExportUtils.ts`). Each is an EasyPost shipment in the shape the
//! Node app's postage routes take, so a purchase sends it as it is.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::orders::Order;
use crate::features::shipping_configuration::{
    Address, LabelFormat, LabelSize, Package, Service, ShippingConfig,
};

/// A letter's size when it goes First class, whatever the settings say.
#[allow(dead_code, reason = "the label panel still to land changes a service")]
const FIRST_CLASS_LETTER: (f64, f64, f64) = (9.0, 4.0, 0.25);
/// An order worth this much (dollars) needs a signature.
const SIGNATURE_FROM: f64 = 250.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PackageType {
    Letter,
    Flat,
    Parcel,
}

impl PackageType {
    pub fn label(self) -> &'static str {
        match self {
            PackageType::Letter => "Letter",
            PackageType::Flat => "Flat",
            PackageType::Parcel => "Parcel",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeliveryConfirmation {
    NoSignature,
    Signature,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Parcel {
    pub length: f64,
    pub width: f64,
    pub height: f64,
    /// Ounces.
    pub weight: f64,
    pub predefined_package: PackageType,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LabelOptions {
    pub label_format: LabelFormat,
    pub label_size: LabelSize,
    pub invoice_number: String,
    pub delivery_confirmation: DeliveryConfirmation,
}

/// One package, as EasyPost buys postage for it. Its reference is the first order's number.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Shipment {
    pub reference: String,
    pub to_address: Address,
    pub from_address: Address,
    pub return_address: Address,
    pub parcel: Parcel,
    /// Always `USPS`.
    pub carrier: String,
    pub service: Service,
    pub options: LabelOptions,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, corten::UrlValue)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Outbound,
    Return,
}

impl Shipment {
    /// The same package sent back: the addresses swapped.
    pub fn returned(&self) -> Shipment {
        Shipment {
            to_address: self.from_address.clone(),
            from_address: self.to_address.clone(),
            ..self.clone()
        }
    }

    pub fn toward(&self, direction: Direction) -> Shipment {
        match direction {
            Direction::Outbound => self.clone(),
            Direction::Return => self.returned(),
        }
    }

    /// The full address it goes to, on one line.
    pub fn recipient(&self) -> String {
        let a = &self.to_address;
        [
            Some(a.name.clone()),
            a.company.clone(),
            Some(a.street1.clone()),
            a.street2.clone(),
            Some(format!("{}, {} {}", a.city, a.state, a.zip)),
            Some(a.country.clone()),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(", ")
    }

    /// The shipment with another service. First class is a letter, so the package becomes one,
    /// weighed for `order` when it is known.
    #[allow(dead_code, reason = "the label panel still to land changes a service")]
    pub fn with_service(
        &self,
        service: Service,
        config: &ShippingConfig,
        order: Option<&Order>,
    ) -> Shipment {
        if service != Service::First {
            return Shipment {
                service,
                ..self.clone()
            };
        }
        let (length, width, height) = FIRST_CLASS_LETTER;
        Shipment {
            service,
            parcel: Parcel {
                length,
                width,
                height,
                weight: order.map_or(self.parcel.weight, |o| weight(&config.letter, o.item_count)),
                predefined_package: PackageType::Letter,
            },
            options: LabelOptions {
                label_size: config.letter.label_size,
                ..self.options.clone()
            },
            ..self.clone()
        }
    }
}

/// A shipment and the orders it carries, in the order they were placed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    pub shipment: Shipment,
    #[serde(rename = "orderNumbers")]
    pub orders: Vec<String>,
}

impl Planned {
    pub fn reference(&self) -> &str {
        &self.shipment.reference
    }
}

/// The columns of EasyPost's shipment CSV import, each a field of the shipment.
const CSV_COLUMNS: [&str; 42] = [
    "reference",
    "to_address.name",
    "to_address.company",
    "to_address.phone",
    "to_address.email",
    "to_address.street1",
    "to_address.street2",
    "to_address.city",
    "to_address.state",
    "to_address.zip",
    "to_address.country",
    "from_address.name",
    "from_address.company",
    "from_address.phone",
    "from_address.email",
    "from_address.street1",
    "from_address.street2",
    "from_address.city",
    "from_address.state",
    "from_address.zip",
    "from_address.country",
    "return_address.name",
    "return_address.company",
    "return_address.phone",
    "return_address.email",
    "return_address.street1",
    "return_address.street2",
    "return_address.city",
    "return_address.state",
    "return_address.zip",
    "return_address.country",
    "parcel.length",
    "parcel.width",
    "parcel.height",
    "parcel.weight",
    "parcel.predefined_package",
    "carrier",
    "service",
    "options.label_format",
    "options.label_size",
    "options.invoice_number",
    "options.delivery_confirmation",
];

/// Shipments as the CSV EasyPost imports (`getShipmentCsvRows`): a field missing is empty, and a
/// number is written as JavaScript wrote it (`4`, `0.87`).
pub fn csv(shipments: &[Shipment]) -> String {
    let rows = shipments.iter().map(|shipment| {
        let json = serde_json::to_value(shipment).unwrap_or_default();
        CSV_COLUMNS
            .iter()
            .map(
                |column| match json.pointer(&format!("/{}", column.replace('.', "/"))) {
                    Some(serde_json::Value::String(text)) => text.clone(),
                    Some(serde_json::Value::Number(n)) => {
                        n.as_f64().map_or_else(String::new, |n| n.to_string())
                    }
                    _ => String::new(),
                },
            )
            .collect()
    });
    crate::csv_text::unparse(&CSV_COLUMNS, rows)
}

/// What a shipment's CSV is saved as: `EasyPost_Shipments_4x6_2026.10.29.17.05.00.csv`, or
/// `EasyPost_Returns_..` for the way back. The React screen meant this stamp, but its pattern cut
/// it to the year.
pub fn csv_file_name(shipment: &Shipment, direction: Direction, at: DateTime<Utc>) -> String {
    let what = match direction {
        Direction::Outbound => "Shipments",
        Direction::Return => "Returns",
    };
    format!(
        "EasyPost_{what}_{}_{}.csv",
        shipment.options.label_size,
        at.format("%Y.%m.%d.%H.%M.%S")
    )
}

/// A batch of orders and the shipments they go out as, oldest order first.
#[derive(Clone, Debug, Default)]
pub struct Batch {
    pub orders: Vec<Order>,
    pub shipments: Vec<Planned>,
}

impl Batch {
    /// The orders sorted oldest first and, when the settings combine them, those to one address
    /// in one package (`buildShippingWorkflowOrderState`).
    pub fn plan(orders: Vec<Order>, config: &ShippingConfig) -> Batch {
        let orders = oldest_first(orders);
        let shipments = grouped(&orders, config.combine_orders)
            .into_iter()
            .map(|(order, carried)| Planned {
                shipment: shipment_for(&order, config),
                orders: carried,
            })
            .collect();
        Batch { orders, shipments }
    }

    pub fn order(&self, number: &str) -> Option<&Order> {
        self.orders.iter().find(|o| o.number == number)
    }

    pub fn shipment(&self, reference: &str) -> Option<&Planned> {
        self.shipments.iter().find(|p| p.reference() == reference)
    }

    /// The loaded orders a shipment carries.
    pub fn orders_of<'a>(&'a self, planned: &'a Planned) -> impl Iterator<Item = &'a Order> + 'a {
        planned.orders.iter().filter_map(|n| self.order(n))
    }

    /// Every order number, in the order the shipments go: what the pull sheet and packing slips
    /// are made for.
    pub fn order_numbers(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.shipments
            .iter()
            .flat_map(|p| p.orders.iter())
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty() && seen.insert(n.clone()))
            .collect()
    }

    pub fn item_count(&self) -> u32 {
        self.orders.iter().map(|o| o.item_count).sum()
    }

    /// The label sizes the shipments use, in the order the settings list them.
    pub fn label_sizes(&self) -> Vec<LabelSize> {
        LabelSize::ALL
            .into_iter()
            .filter(|size| {
                self.shipments
                    .iter()
                    .any(|p| p.shipment.options.label_size == *size)
            })
            .collect()
    }
}

/// Oldest first; orders placed together keep their order, and one with no date goes last.
fn oldest_first(mut orders: Vec<Order>) -> Vec<Order> {
    orders.sort_by_key(|o| o.placed_at().unwrap_or(i64::MAX));
    orders
}

/// Each shipment's order (the first one to its address, its counts and value summed, expedited
/// when any is) and the numbers of the orders it carries.
fn grouped(orders: &[Order], combine: bool) -> Vec<(Order, Vec<String>)> {
    if !combine {
        return orders
            .iter()
            .map(|o| (o.clone(), vec![o.number.clone()]))
            .collect();
    }
    let mut groups: Vec<(Order, Vec<String>)> = Vec::new();
    let mut by_address: HashMap<String, usize> = HashMap::new();
    for order in orders {
        if groups
            .iter()
            .any(|(_, carried)| carried.contains(&order.number))
        {
            continue;
        }
        let key = [
            order.address1.as_str(),
            &order.address2,
            &order.city,
            &order.state,
            &zip(&order.postal_code),
            &order.country,
        ]
        .join("|");
        match by_address.get(&key) {
            None => {
                by_address.insert(key, groups.len());
                groups.push((order.clone(), vec![order.number.clone()]));
            }
            Some(&at) => {
                let (first, carried) = &mut groups[at];
                carried.push(order.number.clone());
                first.item_count += order.item_count;
                first.value_of_products += order.value_of_products;
                if order.expedited() {
                    first.shipping_method = order.shipping_method.clone();
                }
            }
        }
    }
    groups
}

/// Five digits, or ZIP+4, from whatever the order holds.
pub fn zip(postal_code: &str) -> String {
    let digits: String = postal_code.chars().filter(char::is_ascii_digit).collect();
    match digits.len() {
        0 => String::new(),
        1..=5 => format!("{digits:0>5}"),
        _ => {
            let nine = format!("{:0<9}", &digits[..digits.len().min(9)]);
            format!("{}-{}", &nine[..5], &nine[5..])
        }
    }
}

fn over(limit: Option<f64>, value: f64) -> bool {
    limit.is_some_and(|l| value > l)
}

fn at_least(limit: Option<f64>, value: f64) -> bool {
    limit.is_some_and(|l| value >= l)
}

pub fn service_for(order: &Order, config: &ShippingConfig) -> Service {
    if order.expedited() {
        config.expedited_service
    } else if at_least(config.flat.max_value_usd, order.value_of_products)
        || over(config.flat.max_item_count, f64::from(order.item_count))
    {
        Service::GroundAdvantage
    } else {
        Service::First
    }
}

pub fn package_for(order: &Order, config: &ShippingConfig) -> PackageType {
    let items = f64::from(order.item_count);
    if over(config.flat.max_item_count, items)
        || order.expedited()
        || at_least(config.flat.max_value_usd, order.value_of_products)
    {
        PackageType::Parcel
    } else if over(config.letter.max_item_count, items) {
        PackageType::Flat
    } else {
        PackageType::Letter
    }
}

fn weight(package: &Package, items: u32) -> f64 {
    ((package.base_weight_oz + f64::from(items) * package.per_item_weight_oz) * 100.0).ceil()
        / 100.0
}

fn address_of(order: &Order) -> Address {
    Address {
        name: order.recipient(),
        street1: order.address1.clone(),
        street2: Some(order.address2.clone()).filter(|s| !s.is_empty()),
        city: order.city.clone(),
        state: order.state.clone(),
        zip: zip(&order.postal_code),
        country: if order.country.is_empty() {
            "US".into()
        } else {
            order.country.clone()
        },
        ..Address::default()
    }
}

/// The shipment an order (or a combined one) goes out as (`mapOrderToShipment`).
pub fn shipment_for(order: &Order, config: &ShippingConfig) -> Shipment {
    let kind = package_for(order, config);
    let package = match kind {
        PackageType::Letter => &config.letter,
        PackageType::Flat => &config.flat,
        PackageType::Parcel => &config.parcel,
    };
    Shipment {
        reference: order.number.clone(),
        to_address: address_of(order),
        from_address: config.from_address.clone(),
        return_address: config.from_address.clone(),
        parcel: Parcel {
            length: package.length_in,
            width: package.width_in,
            height: package.height_in,
            weight: weight(package, order.item_count),
            predefined_package: kind,
        },
        carrier: "USPS".into(),
        service: service_for(order, config),
        options: LabelOptions {
            label_format: config.label_format,
            label_size: package.label_size,
            invoice_number: order.number.clone(),
            delivery_confirmation: if order.value_of_products >= SIGNATURE_FROM {
                DeliveryConfirmation::Signature
            } else {
                DeliveryConfirmation::NoSignature
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::shipping_export::orders::tests::order;

    fn config() -> ShippingConfig {
        ShippingConfig::default()
    }

    #[test]
    fn a_shipment_is_written_as_easyposts_csv() {
        let mut shipment = shipment_for(&order("A"), &config());
        shipment.parcel.length = 9.0;
        shipment.parcel.weight = 0.87;
        let text = csv(std::slice::from_ref(&shipment));
        let mut reader = ::csv::Reader::from_reader(text.as_bytes());
        let header: Vec<String> = reader
            .headers()
            .unwrap()
            .iter()
            .map(str::to_owned)
            .collect();
        assert_eq!(header, CSV_COLUMNS);
        let row = reader.records().next().unwrap().unwrap();
        let at = |column: &str| &row[CSV_COLUMNS.iter().position(|c| *c == column).unwrap()];
        assert_eq!(at("reference"), "A");
        assert_eq!((at("parcel.length"), at("parcel.weight")), ("9", "0.87"));
        assert_eq!(at("to_address.company"), "", "a missing field is empty");
        assert_eq!(
            at("options.label_size"),
            shipment.options.label_size.to_string()
        );
        assert_eq!(at("options.delivery_confirmation"), "NO_SIGNATURE");
    }

    #[test]
    fn a_csv_is_named_for_its_way_size_and_time() {
        use chrono::TimeZone;
        let shipment = shipment_for(&order("A"), &config());
        let at = Utc.with_ymd_and_hms(2026, 10, 29, 17, 5, 0).unwrap();
        assert_eq!(
            csv_file_name(&shipment, Direction::Return, at),
            format!(
                "EasyPost_Returns_{}_2026.10.29.17.05.00.csv",
                shipment.options.label_size
            )
        );
    }

    #[test]
    fn a_zip_is_five_digits_or_zip_plus_four() {
        assert_eq!(zip("6720"), "06720");
        assert_eq!(zip("67101-1234"), "67101-1234");
        assert_eq!(zip("671011"), "67101-1000");
        assert_eq!(zip(""), "");
    }

    #[test]
    fn orders_to_one_address_ship_together_oldest_first() {
        let mut a = order("A");
        a.order_date = "2026-04-12".into();
        let mut b = order("B");
        b.order_date = "2026-04-10".into();
        b.shipping_method = "Expedited".into();
        b.postal_code = "75001".into();
        let mut c = order("C");
        c.address1 = "9 Oak".into();
        let batch = Batch::plan(vec![a, b, c], &config());
        assert_eq!(
            batch
                .orders
                .iter()
                .map(|o| o.number.as_str())
                .collect::<Vec<_>>(),
            ["B", "C", "A"]
        );
        let carried: Vec<_> = batch.shipments.iter().map(|p| p.orders.clone()).collect();
        assert_eq!(carried, [vec!["B", "A"], vec!["C"]]);
        let first = &batch.shipments[0].shipment;
        assert_eq!(first.reference, "B");
        assert_eq!(first.parcel.predefined_package, PackageType::Parcel);
        assert_eq!(first.service, Service::GroundAdvantage);
        assert_eq!(batch.order_numbers(), ["B", "A", "C"]);
    }

    #[test]
    fn the_package_follows_the_count_value_and_method() {
        let config = config();
        let mut small = order("1");
        small.item_count = 24;
        assert_eq!(package_for(&small, &config), PackageType::Letter);
        assert_eq!(service_for(&small, &config), Service::First);
        small.item_count = 25;
        assert_eq!(package_for(&small, &config), PackageType::Flat);
        small.item_count = 101;
        assert_eq!(package_for(&small, &config), PackageType::Parcel);
        assert_eq!(service_for(&small, &config), Service::GroundAdvantage);
        let mut dear = order("2");
        dear.value_of_products = 50.0;
        assert_eq!(package_for(&dear, &config), PackageType::Parcel);
        dear.value_of_products = 250.0;
        assert_eq!(
            shipment_for(&dear, &config).options.delivery_confirmation,
            DeliveryConfirmation::Signature
        );
    }

    #[test]
    fn a_shipment_is_weighed_up_to_the_hundredth_and_keeps_the_easypost_shape() {
        let shipment = shipment_for(&order("1001"), &config());
        assert_eq!(
            shipment.parcel.weight, 0.87,
            "0.6 oz and 3 cards, as the React app weighs it"
        );
        let json = serde_json::to_value(&shipment).unwrap();
        assert_eq!(json["parcel"]["predefined_package"], "Letter");
        assert_eq!(json["options"]["label_size"], "7x3");
        assert_eq!(json["options"]["delivery_confirmation"], "NO_SIGNATURE");
        assert!(json["to_address"].get("street2").is_none());
    }

    #[test]
    fn first_class_makes_the_package_a_letter() {
        let config = config();
        let mut big = order("1");
        big.item_count = 120;
        let parcel = shipment_for(&big, &config);
        let letter = parcel.with_service(Service::First, &config, Some(&order("1")));
        assert_eq!(letter.parcel.predefined_package, PackageType::Letter);
        assert_eq!((letter.parcel.length, letter.parcel.width), (9.0, 4.0));
        assert_eq!(letter.options.label_size, LabelSize::SevenByThree);
        assert_eq!(letter.parcel.weight, 0.87);
        let returned = parcel.returned();
        assert_eq!(returned.to_address, parcel.from_address);
        assert_eq!(returned.from_address, parcel.to_address);
    }
}
