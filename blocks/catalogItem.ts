import { AppBlock, events, kv, http } from "@slflows/sdk/v1";
import {
  createCatalogItem,
  createVariable,
  createQuestionChoice,
  createBusinessRule,
  createRestMessage,
  createRestMessageFunction,
  deleteTableRecord,
  lookupCategoryByName,
  mapVariableType,
  type CreatedResource,
  type ServiceNowCredentials,
} from "../utils/serviceNowClient";
import { generateBusinessRuleScript } from "../templates/businessRule";

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
  name: "Catalog Item",
  description: "Creates a ServiceNow catalog item that triggers Flows when requested",
  category: "Service Catalog",

  config: {
    catalogItemName: {
      name: "Catalog Item Name",
      description: "Name of the catalog item in ServiceNow",
      type: "string",
      required: true,
      fixed: true,
    },
    catalogItemDescription: {
      name: "Description",
      description: "Description of the catalog item",
      type: "string",
      required: false,
      fixed: true,
    },
    category: {
      name: "Category",
      description: "ServiceNow category name or sys_id (e.g., 'Services', 'Hardware'). Will be looked up automatically if a name is provided.",
      type: "string",
      required: false,
      default: "Services",
      fixed: true,
    },
    variables: {
      name: "Variables",
      description: "Variables/parameters for the catalog item. Type can be one of `\"string\"`, `\"text\"`, `\"boolean\"`, `\"number\"`, `\"select\"`, or `\"password\"`.",
      fixed: true,
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
    const { accessToken } = input.app.signals;
    const instanceUrl = input.app.config.instanceUrl;

    if (!accessToken) {
      return {
        newStatus: "failed",
        customStatusDescription: "App not authenticated - check app configuration",
      };
    }

    if (!instanceUrl) {
      return {
        newStatus: "failed",
        customStatusDescription: "ServiceNow instance URL not configured",
      };
    }

    try {
      const credentials: ServiceNowCredentials = {
        instanceUrl: instanceUrl as string,
        accessToken: accessToken as string,
      };

      // Check if already fully set up
      const storedCatalogItemId = await kv.block.get("catalogItemId");

      if (storedCatalogItemId?.value) {
        // Already set up, just return ready
        return {
          newStatus: "ready",
          signalUpdates: {
            catalogItemId: storedCatalogItemId.value,
            catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${storedCatalogItemId.value}`,
          },
        };
      }

      // Create all resources in one pass
      console.log(`Creating catalog item: ${catalogItemName}`);
      const createdResources: CreatedResource[] = [];

      // 1. Look up category sys_id if category name provided
      let categorySysId = "";
      const categoryNameOrId = (category as string) || "Services"; // Default to "Services"

      if (categoryNameOrId) {
        console.log(`Looking up category: ${categoryNameOrId}`);
        // First try to use it as-is (in case user provided sys_id directly)
        // If it looks like a sys_id (32 chars hex), use directly
        if (/^[a-f0-9]{32}$/i.test(categoryNameOrId)) {
          categorySysId = categoryNameOrId;
          console.log(`Using provided category sys_id: ${categorySysId}`);
        } else {
          // Look up by name
          const lookedUpSysId = await lookupCategoryByName(credentials, categoryNameOrId);
          if (lookedUpSysId) {
            categorySysId = lookedUpSysId;
            console.log(`✓ Category "${categoryNameOrId}" found: ${categorySysId}`);
          } else {
            console.warn(`Category "${categoryNameOrId}" not found, creating without category`);
          }
        }
      }

      // 2. Create catalog item
      const catalogItemResource = await createCatalogItem(credentials, {
        name: catalogItemName as string,
        description: catalogItemDescription as string,
        category: categorySysId,
      });
      createdResources.push(catalogItemResource);
      console.log(`✓ Catalog item created: ${catalogItemResource.id}`);

      // 3. Generate API credentials and create REST Message
      const apiUser = `spacelift_flows_${input.block.id.substring(0, 8)}`;
      const apiPassword = generateApiPassword();
      const restMessageName = `Spacelift_Flows_${input.block.id.substring(0, 8)}`;

      console.log(`Creating REST Message: ${restMessageName}`);
      const restMessageResource = await createRestMessage(credentials, {
        name: restMessageName,
        authUser: apiUser,
        authPassword: apiPassword,
      });
      createdResources.push(restMessageResource);
      console.log(`✓ REST Message created: ${restMessageResource.id}`);

      // 4. Create REST Message Function
      const restMessageFnName = "CallFlows";
      console.log(`Creating REST Message Function: ${restMessageFnName}`);
      const restMessageFnResource = await createRestMessageFunction(credentials, {
        restMessageId: restMessageResource.id,
        name: restMessageFnName,
        endpoint: `${input.block.http?.url}/request`,
        httpMethod: "POST",
      });
      createdResources.push(restMessageFnResource);
      console.log(`✓ REST Message Function created: ${restMessageFnResource.id}`);

      // 5. Create variables
      console.log(`Creating ${(variables as CatalogVariable[]).length} variables`);
      for (const variable of variables as CatalogVariable[]) {
        const variableResource = await createVariable(credentials, {
          catalogItemId: catalogItemResource.id,
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
      console.log(`✓ Created ${(variables as CatalogVariable[]).length} variables`);

      // 6. Create business rule
      console.log("Creating business rule");
      const script = generateBusinessRuleScript({
        catalogItemName: catalogItemName as string,
        restMessageName,
        restMessageFnName,
      });

      const businessRuleResource = await createBusinessRule(credentials, {
        name: `Spacelift Flows - ${catalogItemName}`,
        catalogItemId: catalogItemResource.id,
        script,
      });
      createdResources.push(businessRuleResource);
      console.log(`✓ Business rule created: ${businessRuleResource.id}`);

      // Store everything
      await kv.block.setMany([
        { key: "catalogItemId", value: catalogItemResource.id },
        { key: "apiUser", value: apiUser },
        { key: "apiPassword", value: apiPassword },
        { key: "restMessageName", value: restMessageName },
        { key: "restMessageFnName", value: restMessageFnName },
        { key: "createdResources", value: createdResources },
      ]);

      console.log("✓ Catalog item fully configured and ready");

      return {
        newStatus: "ready",
        signalUpdates: {
          catalogItemId: catalogItemResource.id,
          catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${catalogItemResource.id}`,
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
    const { accessToken } = input.app.signals;
    const instanceUrl = input.app.config.instanceUrl;

    if (!accessToken) {
      // If no auth, just clean up local state
      await kv.block.delete([
        "catalogItemId",
        "apiUser",
        "apiPassword",
        "restMessageName",
        "restMessageFnName",
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
        "apiUser",
        "apiPassword",
        "restMessageName",
        "restMessageFnName",
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

        // Validate Basic Auth
        const authHeader = request.headers["Authorization"];
        if (!authHeader || !authHeader.startsWith("Basic ")) {
          await http.respond(request.requestId, {
            statusCode: 401,
            body: { error: "Missing or invalid authentication" },
          });
          return;
        }

        // Decode and validate credentials
        const base64Credentials = authHeader.substring(6);
        const credentials = Buffer.from(base64Credentials, "base64").toString("utf-8");
        const [username, password] = credentials.split(":");

        const [{ value: storedUser }, { value: storedPassword }] = await kv.block.getMany([
          "apiUser",
          "apiPassword",
        ]);

        if (!storedUser || !storedPassword || username !== storedUser || password !== storedPassword) {
          await http.respond(request.requestId, {
            statusCode: 401,
            body: { error: "Invalid credentials" },
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
 * Generates a secure random API password
 */
function generateApiPassword(): string {
  // Generate a secure 32-character password
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  const randomValues = new Uint8Array(32);
  crypto.getRandomValues(randomValues);

  return Array.from(randomValues)
    .map((value) => chars[value % chars.length])
    .join("");
}
