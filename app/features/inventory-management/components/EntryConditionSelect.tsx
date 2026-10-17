import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import {
  INVENTORY_CONDITION_ORDER,
  type InventorySelectableCondition,
} from "../../../core/utils/conditionOrder";

/** The condition new quantities are entered in. */
export function EntryConditionSelect({
  value,
  onChange,
}: {
  value: InventorySelectableCondition;
  onChange: (condition: InventorySelectableCondition) => void;
}) {
  return (
    <FormControl sx={{ minWidth: 200 }}>
      <InputLabel id="inventory-condition-label">Entry condition</InputLabel>
      <Select
        labelId="inventory-condition-label"
        value={value}
        label="Entry condition"
        onChange={(event) => onChange(event.target.value as InventorySelectableCondition)}
      >
        {INVENTORY_CONDITION_ORDER.map((condition) => (
          <MenuItem key={condition} value={condition}>
            {condition}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
