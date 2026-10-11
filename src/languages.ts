/** Språk som stöds för textning. Källspråket avgörs av transkriptionsmodellen. */
export const LANGUAGES: Record<string, string> = {
  sv: 'Svenska',
  en: 'English',
  fi: 'Suomi',
  no: 'Norsk',
  da: 'Dansk',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  pl: 'Polski',
  uk: 'Українська',
  ar: 'العربية',
  fa: 'فارسی',
  so: 'Soomaali',
  nl: 'Nederlands',
  zh: '中文',
};

export function languageName(code: string): string {
  return LANGUAGES[code] ?? code;
}

export function isValidLanguage(code: string): boolean {
  return code in LANGUAGES;
}
