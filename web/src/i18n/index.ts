/** Translation lookup. */

import { create } from 'zustand'
import { en, type TranslationKey } from './en'
import { ru } from './ru'

export type Language = 'en' | 'ru'

const DICTIONARIES: Record<Language, Partial<Record<TranslationKey, string>>> = { en, ru }

const STORAGE_KEY = 'ffweb.lang'

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'ru' || saved === 'en') return saved
  } catch {
    // Storage can be unavailable; the browser's own preference still applies.
  }
  return navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

interface LanguageState {
  language: Language
  setLanguage: (language: Language) => void
}

export const useLanguage = create<LanguageState>((set) => ({
  language: initialLanguage(),
  setLanguage: (language) => {
    try {
      localStorage.setItem(STORAGE_KEY, language)
    } catch {
      // Not being able to remember the choice is not worth an error.
    }
    document.documentElement.lang = language
    set({ language })
  },
}))

/**
 * Look up a key, filling `{name}` placeholders. An unknown key falls through to
 * English and then to the key itself, so a missing translation degrades into
 * something readable rather than a blank.
 */
export function translate(
  language: Language,
  key: string,
  values?: Record<string, string | number>,
): string {
  const dictionary = DICTIONARIES[language] as Record<string, string | undefined>
  let text = dictionary[key] ?? (en as Record<string, string | undefined>)[key] ?? key
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** Translate, or fall back to a raw value — used for codec and preset names. */
function translateOr(language: Language, key: string, fallback: string): string {
  const dictionary = DICTIONARIES[language] as Record<string, string | undefined>
  return dictionary[key] ?? (en as Record<string, string | undefined>)[key] ?? fallback
}

export function useT() {
  const language = useLanguage((state) => state.language)
  return {
    language,
    t: (key: string, values?: Record<string, string | number>) => translate(language, key, values),
    tOr: (key: string, fallback: string) => translateOr(language, key, fallback),
  }
}
