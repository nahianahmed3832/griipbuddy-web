export const MAX_PERSONALIZATION_LENGTH = 120;
export const MAX_PERSONALIZATION_PROMPT = 180;

export type Personalization = { prompt: string; required: boolean };

export function personalizationText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= MAX_PERSONALIZATION_LENGTH && !/[\p{Cc}\u2028\u2029]/u.test(text)
    ? text
    : undefined;
}

export function personalizationAvailable(settings: Personalization | undefined, value?: string) {
  if (!value) return !settings?.required;
  return Boolean(settings && personalizationText(value));
}
