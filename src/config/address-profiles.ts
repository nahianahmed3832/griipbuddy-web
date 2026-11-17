import { usPreviewStates } from "../lib/commerce/us-delivery.ts";

export const canadaProvinces = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"], ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"], ["NS", "Nova Scotia"], ["NT", "Northwest Territories"],
  ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island"], ["QC", "Quebec"],
  ["SK", "Saskatchewan"], ["YT", "Yukon"],
] as const;

export const northAmericanAddressProfiles = {
  us: { country: "US", regionLabel: "State", regionPrompt: "Select a state", regions: usPreviewStates,
    postalLabel: "ZIP code", postalNumeric: true, postalLength: 10, postalPattern: "[0-9]{5}(?:-[0-9]{4})?" },
  ca: { country: "CA", regionLabel: "Province or territory", regionPrompt: "Select a province or territory", regions: canadaProvinces,
    postalLabel: "Postal code", postalNumeric: false, postalLength: 7, postalPattern: "[A-Za-z][0-9][A-Za-z] ?[0-9][A-Za-z][0-9]" },
} as const;
