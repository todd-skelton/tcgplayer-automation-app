//! A shipment edited by hand before its postage is bought (`ShipmentEditDrawer`): where it goes,
//! its reference, service, parcel and label. The edit is kept for the batch (`Workflow::edits`).
use corten::prelude::*;
use serde::Deserialize;

use super::shipments::Shipment;
use crate::features::shipping_configuration::{LabelFormat, LabelSize, Service, measure_text};

/// The editor as the browser sends it.
#[derive(Clone, Debug, Deserialize, Fields)]
pub struct ShipmentInput {
    pub name: String,
    pub street1: String,
    pub street2: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub reference: String,
    pub service: Service,
    pub length: String,
    pub width: String,
    pub height: String,
    pub weight: String,
    pub label_format: LabelFormat,
    pub label_size: LabelSize,
}

impl ShipmentInput {
    /// The editor filled with `shipment`.
    pub fn of(shipment: &Shipment) -> Self {
        let (a, p) = (&shipment.to_address, &shipment.parcel);
        ShipmentInput {
            name: a.name.clone(),
            street1: a.street1.clone(),
            street2: a.street2.clone().unwrap_or_default(),
            city: a.city.clone(),
            state: a.state.clone(),
            zip: a.zip.clone(),
            reference: shipment.reference.clone(),
            service: shipment.service,
            length: measure_text(p.length),
            width: measure_text(p.width),
            height: measure_text(p.height),
            weight: measure_text(p.weight),
            label_format: shipment.options.label_format,
            label_size: shipment.options.label_size,
        }
    }

    /// `shipment` as the editor says, or why it cannot be. The reference names the shipment in
    /// the batch and on EasyPost, so it is needed and no other shipment's (`taken`); each measure
    /// is a number of at least zero. The React drawer took whatever `Number()` made of them.
    pub fn read(
        &self,
        shipment: &Shipment,
        taken: impl Fn(&str) -> bool,
    ) -> Result<Shipment, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let reference = self.reference.trim();
        if reference.is_empty() {
            errors.add(f.reference, "Enter the shipment's reference.");
        } else if reference != shipment.reference && taken(reference) {
            errors.add(
                f.reference,
                format!("Shipment {reference} is already in this batch."),
            );
        }
        let mut number = |field: FieldName<String>, text: &str, what: &str| -> f64 {
            match text.trim().parse::<f64>() {
                Ok(n) if n.is_finite() && n >= 0.0 => n,
                _ => {
                    errors.add(field, format!("The {what} must be a number of at least 0."));
                    0.0
                }
            }
        };
        let (length, width, height, weight) = (
            number(f.length, &self.length, "length"),
            number(f.width, &self.width, "width"),
            number(f.height, &self.height, "height"),
            number(f.weight, &self.weight, "weight"),
        );
        let mut edited = self.with_address(shipment);
        edited.reference = reference.to_owned();
        edited.service = self.service;
        edited.parcel.length = length;
        edited.parcel.width = width;
        edited.parcel.height = height;
        edited.parcel.weight = weight;
        edited.options.label_format = self.label_format;
        edited.options.label_size = self.label_size;
        errors.into_result(edited)
    }

    /// `shipment` going where the editor says, and otherwise as it was.
    pub fn with_address(&self, shipment: &Shipment) -> Shipment {
        let street2 = self.street2.trim();
        let mut moved = shipment.clone();
        let to = &mut moved.to_address;
        to.name = self.name.trim().to_owned();
        to.street1 = self.street1.trim().to_owned();
        to.street2 = (!street2.is_empty()).then(|| street2.to_owned());
        to.city = self.city.trim().to_owned();
        to.state = self.state.trim().to_owned();
        to.zip = self.zip.trim().to_owned();
        moved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{
        shipping_configuration::ShippingConfig,
        shipping_export::{orders::tests::order, shipments::shipment_for},
    };

    fn shipment() -> Shipment {
        shipment_for(&order("A"), &ShippingConfig::default())
    }

    #[test]
    fn the_editor_of_a_shipment_reads_back_as_it() {
        // The editor shows a measure to six places, so a weight summed to 0.8700000000000001
        // reads back as 0.87.
        let mut shipment = shipment();
        shipment.parcel.weight = 1.25;
        let read = ShipmentInput::of(&shipment)
            .read(&shipment, |_| true)
            .unwrap();
        assert_eq!(read, shipment);
    }

    #[test]
    fn an_edit_changes_what_it_says_and_keeps_the_rest() {
        let shipment = shipment();
        let mut input = ShipmentInput::of(&shipment);
        input.street2 = " Apt 4 ".into();
        input.weight = "3.5".into();
        input.service = Service::Priority;
        let read = input.read(&shipment, |_| false).unwrap();
        assert_eq!(read.to_address.street2.as_deref(), Some("Apt 4"));
        assert_eq!((read.parcel.weight, read.service), (3.5, Service::Priority));
        assert_eq!(read.from_address, shipment.from_address);
    }

    #[test]
    fn a_reference_is_needed_and_not_another_shipments() {
        let shipment = shipment();
        let f = ShipmentInput::FIELDS;
        let mut input = ShipmentInput::of(&shipment);
        input.reference = "B".into();
        input.weight = "heavy".into();
        let errors = input.read(&shipment, |r| r == "B").unwrap_err();
        assert_eq!(
            errors.get(f.reference),
            Some("Shipment B is already in this batch.")
        );
        assert_eq!(
            errors.get(f.weight),
            Some("The weight must be a number of at least 0.")
        );
        input.reference = " ".into();
        let errors = input.read(&shipment, |_| false).unwrap_err();
        assert_eq!(
            errors.get(f.reference),
            Some("Enter the shipment's reference.")
        );
    }
}
