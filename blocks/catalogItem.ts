import { AppBlock, events, kv, http, lifecycle } from "@slflows/sdk/v1";
import {
  createCatalogItem,
  createVariable,
  createQuestionChoice,
  createBusinessRule,
  deleteTableRecord,
  mapVariableType,
  type CreatedResource,
  type ServiceNowCredentials,
} from "../utils/serviceNowClient";
import { generateBusinessRuleScript } from "../templates/businessRule";
import { randomUUID } from "node:crypto";

interface CatalogVariable {
  name: string;
  type: "string" | "text" | "boolean" | "number" | "select" | "password";
  label: string;
  description?: string;
  required: boolean;
  default?: string;
  options?: string[];
}

export const catalogItem: AppBlock = {
  name: "Catalog Item Handler",
  description: "Creates a ServiceNow catalog item that triggers Flows when requested",
  category: "Service Catalog",

  config: {
    catalogItemName: {
      name: "Catalog Item Name",
      description: "Name of the catalog item in ServiceNow",
      type: "string",
      required: true,
    },
    catalogItemDescription: {
      name: "Description",
      description: "Description of the catalog item",
      type: "string",
      required: false,
    },
    category: {
      name: "ServiceNow Category",
      description: "Category sys_id in ServiceNow (optional)",
      type: "string",
      required: false,
    },
    variables: {
      name: "Variables",
      description: "Variables/parameters for the catalog item",
      type: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Variable name/ID (no spaces)",
            },
            type: {
              type: "string",
              enum: ["string", "text", "boolean", "number", "select", "password"],
              description: "Variable type",
            },
            label: {
              type: "string",
              description: "Question text shown to users",
            },
            description: {
              type: "string",
              description: "Help text for the variable",
            },
            required: {
              type: "boolean",
              description: "Whether the variable is mandatory",
            },
            default: {
              type: "string",
              description: "Default value",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description: "Options for select type",
            },
          },
          required: ["name", "type", "label", "required"],
        },
      },
      required: true,
      default: [
        {
          name: "example_field",
          type: "string",
          label: "Example Field",
          description: "An example variable",
          required: true,
        },
      ],
    },
  },

  signals: {
    catalogItemId: {
      name: "Catalog Item ID",
      description: "ServiceNow sys_id of the created catalog item",
    },
    catalogItemUrl: {
      name: "Catalog Item URL",
      description: "Direct URL to the catalog item in ServiceNow",
    },
  },

  async onSync(input) {
    const { catalogItemName, catalogItemDescription, category, variables } = input.block.config;
    const { instanceUrl, accessToken } = input.app.signals;

    if (!accessToken) {
      return {
        newStatus: "failed",
        customStatusDescription: "App not authenticated - check app configuration",
      };
    }

    try {
      const credentials: ServiceNowCredentials = {
        instanceUrl: instanceUrl as string,
        accessToken: accessToken as string,
      };

      // Check if catalog item already exists
      const storedCatalogItemId = await kv.block.get("catalogItemId");

      if (!storedCatalogItemId?.value) {
        // Create new catalog item
        console.log(`Creating catalog item: ${catalogItemName}`);

        const catalogItemResource = await createCatalogItem(credentials, {
          name: catalogItemName as string,
          description: catalogItemDescription as string,
          category: category as string,
        });

        // Store the catalog item ID
        await kv.block.set({
          key: "catalogItemId",
          value: catalogItemResource.id,
        });

        // Generate webhook secret
        const webhookSecret = generateWebhookSecret();
        await kv.block.set({
          key: "webhookSecret",
          value: webhookSecret,
        });

        return {
          newStatus: "in_progress",
          customStatusDescription: "Catalog item created, configuring variables",
          nextScheduleDelay: 2,
          signalUpdates: {
            catalogItemId: catalogItemResource.id,
            catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${catalogItemResource.id}`,
          },
        };
      }

      // Check if we've created variables yet
      const storedVariables = await kv.block.get("variablesCreated");
      const catalogItemId = storedCatalogItemId.value;

      if (!storedVariables?.value) {
        // Create variables for the catalog item
        console.log(`Creating ${(variables as CatalogVariable[]).length} variables`);

        const createdResources: CreatedResource[] = [];

        for (const variable of variables as CatalogVariable[]) {
          const variableResource = await createVariable(credentials, {
            catalogItemId: catalogItemId,
            name: variable.name,
            type: mapVariableType(variable.type),
            label: variable.label,
            description: variable.description,
            required: variable.required,
            defaultValue: variable.default,
          });

          createdResources.push(variableResource);

          // Create question choices for select variables
          if (variable.type === "select" && variable.options && variable.options.length > 0) {
            for (const option of variable.options) {
              const choiceResource = await createQuestionChoice(credentials, {
                questionId: variableResource.id,
                value: option,
              });
              createdResources.push(choiceResource);
            }
          }
        }

        // Store created resources
        await kv.block.set({
          key: "createdResources",
          value: createdResources,
        });

        await kv.block.set({
          key: "variablesCreated",
          value: true,
        });

        return {
          newStatus: "in_progress",
          customStatusDescription: "Variables created, setting up business rule",
          nextScheduleDelay: 2,
          signalUpdates: {
            catalogItemId: catalogItemId,
            catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${catalogItemId}`,
          },
        };
      }

      // Check if we've created the business rule yet
      const storedBusinessRule = await kv.block.get("businessRuleCreated");

      if (!storedBusinessRule?.value) {
        // Get webhook secret
        const { value: webhookSecret } = await kv.block.get("webhookSecret");

        if (!webhookSecret) {
          throw new Error("Webhook secret not found");
        }

        // Generate business rule script
        const script = generateBusinessRuleScript({
          catalogItemName: catalogItemName as string,
          blockHttpUrl: input.block.http?.url || "",
          webhookSecret,
        });

        // Create business rule
        console.log("Creating business rule");

        const businessRuleResource = await createBusinessRule(credentials, {
          name: `Spacelift Flows - ${catalogItemName}`,
          catalogItemId: catalogItemId,
          script,
        });

        // Add business rule to created resources
        const { value: createdResources } = await kv.block.get("createdResources");
        const updatedResources = [...(createdResources || []), businessRuleResource];

        await kv.block.set({
          key: "createdResources",
          value: updatedResources,
        });

        await kv.block.set({
          key: "businessRuleCreated",
          value: true,
        });

        return {
          newStatus: "ready",
          customStatusDescription: "Catalog item fully configured and ready",
          signalUpdates: {
            catalogItemId: catalogItemId,
            catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${catalogItemId}`,
          },
        };
      }

      // Everything is already set up
      return {
        newStatus: "ready",
        signalUpdates: {
          catalogItemId: catalogItemId,
          catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${catalogItemId}`,
        },
      };
    } catch (error: any) {
      console.error("Error in catalog item sync:", error.message);
      return {
        newStatus: "failed",
        customStatusDescription: `Setup failed: ${error.message}`,
      };
    }
  },

  async onDrain(input) {
    const { instanceUrl, accessToken } = input.app.signals;

    if (!accessToken) {
      // If no auth, just clean up local state
      await kv.block.delete([
        "catalogItemId",
        "webhookSecret",
        "variablesCreated",
        "businessRuleCreated",
        "createdResources",
      ]);
      return {
        newStatus: "drained",
        signalUpdates: {
          catalogItemId: null,
          catalogItemUrl: null,
        },
      };
    }

    try {
      const credentials: ServiceNowCredentials = {
        instanceUrl: instanceUrl as string,
        accessToken: accessToken as string,
      };

      // Get all created resources
      const { value: createdResources } = await kv.block.get("createdResources");
      const { value: catalogItemId } = await kv.block.get("catalogItemId");

      // Delete all created resources
      if (createdResources && Array.isArray(createdResources)) {
        for (const resource of createdResources) {
          try {
            await deleteTableRecord(credentials, resource.type, resource.id);
          } catch (error) {
            console.warn(`Failed to delete resource ${resource.type}/${resource.id}:`, error);
          }
        }
      }

      // Delete the catalog item itself
      if (catalogItemId) {
        try {
          await deleteTableRecord(credentials, "sc_cat_item", catalogItemId);
        } catch (error) {
          console.warn(`Failed to delete catalog item ${catalogItemId}:`, error);
        }
      }

      // Clean up local storage
      await kv.block.delete([
        "catalogItemId",
        "webhookSecret",
        "variablesCreated",
        "businessRuleCreated",
        "createdResources",
      ]);

      return {
        newStatus: "drained",
        signalUpdates: {
          catalogItemId: null,
          catalogItemUrl: null,
        },
      };
    } catch (error: any) {
      console.error("Error draining catalog item:", error.message);
      return {
        newStatus: "draining_failed",
        customStatusDescription: `Cleanup failed: ${error.message}`,
      };
    }
  },

  http: {
    async onRequest(input) {
      try {
        const { request } = input;

        // Only accept POST requests to /request
        if (request.path !== "/request" || request.method !== "POST") {
          await http.respond(request.requestId, {
            statusCode: 404,
            body: { error: "Not found" },
          });
          return;
        }

        // Validate webhook secret
        const webhookSecret = request.headers["X-Webhook-Secret"];
        const { value: storedSecret } = await kv.block.get("webhookSecret");

        if (!webhookSecret || !storedSecret || webhookSecret !== storedSecret) {
          await http.respond(request.requestId, {
            statusCode: 401,
            body: { error: "Invalid webhook secret" },
          });
          return;
        }

        // Parse request payload
        const payload = request.body;

        if (!payload || !payload.variables || !payload.metadata) {
          await http.respond(request.requestId, {
            statusCode: 400,
            body: { error: "Invalid payload format" },
          });
          return;
        }

        // Respond quickly to ServiceNow
        await http.respond(request.requestId, {
          statusCode: 200,
          body: { success: true, message: "Request received" },
        });

        // Emit event with the catalog item request details
        await events.emit({
          requestItemId: payload.metadata.requestItemId,
          requestNumber: payload.metadata.requestNumber,
          catalogItemName: payload.metadata.catalogItemName,
          requestedBy: payload.metadata.requestedBy,
          requestedFor: payload.metadata.requestedFor,
          requestedDate: payload.metadata.requestedDate,
          variables: payload.variables,
        });
      } catch (error: any) {
        console.error("Error processing webhook:", error.message);

        // Try to respond with error
        try {
          await http.respond(input.request.requestId, {
            statusCode: 500,
            body: { error: "Internal server error" },
          });
        } catch {
          // Response may have already been sent
        }
      }
    },
  },

  outputs: {
    default: {
      name: "Catalog Item Requested",
      description: "Emitted when the ServiceNow catalog item is requested",
      default: true,
      type: {
        type: "object",
        properties: {
          requestItemId: {
            type: "string",
            description: "ServiceNow request item sys_id",
          },
          requestNumber: {
            type: "string",
            description: "ServiceNow request number",
          },
          catalogItemName: {
            type: "string",
            description: "Name of the catalog item",
          },
          requestedBy: {
            type: "string",
            description: "Username who submitted the request",
          },
          requestedFor: {
            type: "string",
            description: "Username the request was submitted for",
          },
          requestedDate: {
            type: "string",
            description: "Date when the request was created",
          },
          variables: {
            type: "object",
            additionalProperties: true,
            description: "All variables from the catalog item request",
          },
        },
        required: ["requestItemId", "requestNumber", "variables"],
      },
    },
  },
};

/**
 * Generates a secure random webhook secret
 */
function generateWebhookSecret(): string {
  return randomUUID();
}
