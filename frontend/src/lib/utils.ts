import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Display-case a Craigslist market name: "san francisco bay area" ->
 * "San Francisco Bay Area". Tokens that are already uppercase ("CO",
 * "SW") stay as-is; capitalizes after spaces, hyphens, and slashes.
 * Display-only — never feed the result back as a search slug.
 */
export function titleCaseLocation(name: string): string {
  return name.replace(/[^\s\/-]+/g, (word) =>
    word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1),
  );
}
