/**
 * Block Registry for ServiceNow App
 *
 * This file exports all blocks as a dictionary for easy registration.
 */

import { catalogItem } from "./catalogItem";
import { updateRequest } from "./updateRequest";

/**
 * Dictionary of all available blocks
 */
export const blocks = {
  catalogItem: catalogItem,
  updateRequest: updateRequest,
} as const;

// Named exports for individual blocks
export { catalogItem, updateRequest };
