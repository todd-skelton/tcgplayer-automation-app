import { useEffect, useState } from "react";
import { TextField, type TextFieldProps } from "@mui/material";

/** A setting edited with a ValidatedNumberField, keyed by the field it sets. */
export interface NumberFieldDescriptor<Settings> {
  key: keyof Settings;
  label: string;
  step: number;
  helperText: string;
}

/** Number field that keeps what was typed and commits every new valid value as it is typed. */
export function ValidatedNumberField({
  label,
  value,
  step,
  helperText,
  isValid,
  onCommit,
  size,
}: {
  label: string;
  value: number;
  step: number;
  helperText: string;
  isValid: (value: number) => boolean;
  onCommit: (value: number) => void;
  size?: TextFieldProps["size"];
}) {
  const [text, setText] = useState(String(value));
  const meansValue = (input: string) => input !== "" && Number(input) === value;
  const accepts = (input: string) =>
    input !== "" && Number.isFinite(Number(input)) && isValid(Number(input));
  useEffect(
    () => setText((current) => (meansValue(current) ? current : String(value))),
    [value],
  );
  return (
    <TextField
      label={label}
      type="number"
      size={size}
      value={text}
      error={text !== "" && !accepts(text)}
      onChange={(event) => {
        const input = event.target.value;
        setText(input);
        if (accepts(input) && !meansValue(input)) onCommit(Number(input));
      }}
      inputProps={{ step }}
      helperText={helperText}
    />
  );
}
