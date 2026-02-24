import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Utility function to combine class names conditionally. The cn function takes any number of class name inputs
 * and merges them into a single string, resolving conflicts according to Tailwind CSS rules.
 *
 * @param inputs A variable number of class name inputs, which can be strings, arrays, or objects. The clsx function processes these inputs to determine which class names should be included based on their truthiness and structure. The twMerge function then takes the resulting class string and merges any conflicting Tailwind CSS classes according to its rules, ensuring that the final output is a clean and optimized string of class names.
 * @returns {string} A single string of combined class names, with duplicates merged according to Tailwind CSS rules. This function is useful for conditionally applying class names in a clean and efficient way, especially when working with Tailwind CSS, as it ensures that conflicting classes are resolved correctly.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
