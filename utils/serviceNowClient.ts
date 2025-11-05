/**
 * ServiceNow API Client Utilities
 *
 * Helper functions for interacting with ServiceNow Table API to create
 * and manage catalog items, variables, and business rules.
 */

// ServiceNow resource types
export const RESOURCE_TYPES = {
  CATALOG_ITEM: "sc_cat_item",
  VARIABLE: "item_option_new",
  QUESTION_CHOICE: "question_choice",
  BUSINESS_RULE: "sys_script",
} as const;

// Variable types in ServiceNow
export enum ServiceNowVariableType {
  SINGLE_LINE_TEXT = 6,
  MULTI_LINE_TEXT = 2,
  CHECKBOX = 7,
  MULTIPLE_CHOICE = 3,
  PASSWORD = 25,
}

export interface ServiceNowCredentials {
  instanceUrl: string;
  accessToken: string;
}

export interface CreatedResource {
  id: string;
  type: string;
}

export interface CatalogItemParams {
  name: string;
  description?: string;
  category?: string;
}

export interface VariableParams {
  catalogItemId: string;
  name: string;
  type: ServiceNowVariableType;
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
}

export interface QuestionChoiceParams {
  questionId: string;
  value: string;
}

export interface BusinessRuleParams {
  name: string;
  catalogItemId: string;
  script: string;
}

/**
 * Creates a record in a ServiceNow table
 */
export async function createTableRecord<T>(
  credentials: ServiceNowCredentials,
  resourceType: string,
  payload: T
): Promise<CreatedResource> {
  const url = `${credentials.instanceUrl}/api/now/table/${resourceType}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    throw new Error("Authentication failed - please check your ServiceNow credentials");
  }

  if (response.status === 403) {
    throw new Error("Insufficient permissions - please verify ServiceNow user roles");
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create ${resourceType}: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  if (!data.result || !data.result.sys_id) {
    throw new Error(`Invalid response from ServiceNow - missing sys_id in response`);
  }

  return {
    id: data.result.sys_id,
    type: resourceType,
  };
}

/**
 * Deletes a record from a ServiceNow table
 */
export async function deleteTableRecord(
  credentials: ServiceNowCredentials,
  resourceType: string,
  resourceId: string
): Promise<void> {
  const url = `${credentials.instanceUrl}/api/now/table/${resourceType}/${resourceId}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    },
  });

  // ServiceNow returns 404 if record doesn't exist - treat as success
  if (response.status === 404) {
    console.log(`Resource ${resourceType}/${resourceId} not found - already deleted`);
    return;
  }

  if (response.status === 401) {
    throw new Error("Authentication failed - please check your ServiceNow credentials");
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete ${resourceType}/${resourceId}: ${response.status} ${errorText}`);
  }
}

/**
 * Creates a catalog item in ServiceNow
 */
export async function createCatalogItem(
  credentials: ServiceNowCredentials,
  params: CatalogItemParams
): Promise<CreatedResource> {
  const payload = {
    name: params.name,
    description: params.description || "",
    short_description: params.description || "",
    category: params.category || "",
    no_quantity_v2: true, // Don't ask for quantity
    no_delivery_time_v2: true, // Don't show delivery time
  };

  return createTableRecord(credentials, RESOURCE_TYPES.CATALOG_ITEM, payload);
}

/**
 * Creates a variable for a catalog item
 */
export async function createVariable(
  credentials: ServiceNowCredentials,
  params: VariableParams
): Promise<CreatedResource> {
  const payload = {
    cat_item: params.catalogItemId,
    type: params.type,
    question_text: params.label,
    name: params.name,
    default_value: params.defaultValue || "",
    mandatory: params.required,
    help_text: params.description || "",
  };

  return createTableRecord(credentials, RESOURCE_TYPES.VARIABLE, payload);
}

/**
 * Creates a question choice for a multiple choice variable
 */
export async function createQuestionChoice(
  credentials: ServiceNowCredentials,
  params: QuestionChoiceParams
): Promise<CreatedResource> {
  const payload = {
    question: params.questionId,
    text: params.value,
    value: params.value,
  };

  return createTableRecord(credentials, RESOURCE_TYPES.QUESTION_CHOICE, payload);
}

/**
 * Creates a business rule that triggers when catalog item is requested
 */
export async function createBusinessRule(
  credentials: ServiceNowCredentials,
  params: BusinessRuleParams
): Promise<CreatedResource> {
  const payload = {
    name: params.name,
    collection: "sc_req_item", // Requested Item table
    when: "async", // Run asynchronously
    condition: `current.cat_item == '${params.catalogItemId}'`,
    script: params.script,
    active: true,
    action_insert: true, // Trigger on insert
  };

  return createTableRecord(credentials, RESOURCE_TYPES.BUSINESS_RULE, payload);
}

/**
 * Maps variable type string to ServiceNow variable type enum
 */
export function mapVariableType(type: string): ServiceNowVariableType {
  const typeMap: Record<string, ServiceNowVariableType> = {
    string: ServiceNowVariableType.SINGLE_LINE_TEXT,
    text: ServiceNowVariableType.MULTI_LINE_TEXT,
    boolean: ServiceNowVariableType.CHECKBOX,
    number: ServiceNowVariableType.SINGLE_LINE_TEXT,
    select: ServiceNowVariableType.MULTIPLE_CHOICE,
    password: ServiceNowVariableType.PASSWORD,
  };

  return typeMap[type] || ServiceNowVariableType.SINGLE_LINE_TEXT;
}

/**
 * Validates ServiceNow instance URL format
 */
export function validateInstanceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.includes("service-now.com");
  } catch {
    return false;
  }
}
