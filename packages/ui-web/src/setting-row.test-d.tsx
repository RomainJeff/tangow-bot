import { SettingRow } from "./setting-row.js";

const open = () => {};

// @ts-expect-error A pressable row never carries a SaveMeta.
export const withMeta = <SettingRow label="Model" onClick={open} meta={<span />} />;

export const withControl = (
  // @ts-expect-error A pressable row never carries a trailing control.
  <SettingRow label="Model" onClick={open}>
    <button type="button" />
  </SettingRow>
);

export const pressable = <SettingRow label="Model" subline="Auto" onClick={open} chevron />;

// @ts-expect-error Only a pressable row opens and closes.
export const staticExpanded = <SettingRow label="Model" expanded />;

export const disclosure = <SettingRow label="Recently deleted" onClick={open} expanded={false} />;
