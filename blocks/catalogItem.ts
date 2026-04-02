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

/**
 * Idempotent sync step helper that stores results in KV storage.
 * If the key already exists, returns the stored value.
 * Otherwise, executes the callback, stores the result, and returns it.
 * This makes onSync resilient to crashes - on retry, already-completed steps are skipped.
 */
async function syncStep<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const stored = await kv.block.get(key);

  if (stored?.value !== undefined) {
    console.log(`✓ Sync step "${key}" already completed, using cached result`);
    return stored.value as T;
  }

  console.log(`Running sync step "${key}"...`);
  const result = await callback();
  await kv.block.set({ key, value: result });
  console.log(`✓ Sync step "${key}" completed and cached`);

  return result;
}

export const catalogItem: AppBlock = {
  name: "Catalog Item",
  description:
    "Creates a ServiceNow catalog item that triggers Flows when requested",
  category: "Service Catalog",
  entrypoint: true,

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
      description:
        "ServiceNow category name or sys_id (e.g., 'Services', 'Hardware'). Will be looked up automatically if a name is provided.",
      type: "string",
      required: false,
      default: "Services",
      fixed: true,
    },
    variables: {
      name: "Variables",
      description:
        'Variables/parameters for the catalog item. Type can be one of `"string"`, `"text"`, `"boolean"`, `"number"`, `"select"`, or `"password"`.',
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
              enum: [
                "string",
                "text",
                "boolean",
                "number",
                "select",
                "password",
              ],
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
    const { catalogItemName, catalogItemDescription, category, variables } =
      input.block.config;
    const { accessToken } = input.app.signals;
    const instanceUrl = input.app.config.instanceUrl;

    if (!accessToken) {
      return {
        newStatus: "failed",
        customStatusDescription:
          "App not authenticated - check app configuration",
      };
    }

    if (!instanceUrl) {
      return {
        newStatus: "failed",
        customStatusDescription: "ServiceNow instance URL not configured",
      };
    }

    const credentials: ServiceNowCredentials = {
      instanceUrl: instanceUrl as string,
      accessToken: accessToken as string,
    };

    // 1. Look up category sys_id if category name provided (idempotent)
    const categorySysId = await syncStep<string>("categorySysId", async () => {
      const categoryNameOrId = (category as string) || "Services";

      if (!categoryNameOrId) {
        return "";
      }

      // If it looks like a sys_id (32 chars hex), use directly
      if (/^[a-f0-9]{32}$/i.test(categoryNameOrId)) {
        console.log(`Using provided category sys_id: ${categoryNameOrId}`);
        return categoryNameOrId;
      }

      // Look up by name
      const lookedUpSysId = await lookupCategoryByName(
        credentials,
        categoryNameOrId,
      );
      if (lookedUpSysId) {
        console.log(`✓ Category "${categoryNameOrId}" found: ${lookedUpSysId}`);
        return lookedUpSysId;
      }

      console.warn(
        `Category "${categoryNameOrId}" not found, creating without category`,
      );
      return "";
    });

    // 2. Create catalog item (idempotent)
    const catalogItemResource = await syncStep<CreatedResource>(
      "catalogItemResource",
      async () => {
        return await createCatalogItem(credentials, {
          name: catalogItemName as string,
          description: catalogItemDescription as string,
          category: categorySysId,
        });
      },
    );

    // 3. Generate API credentials (idempotent)
    const { apiUser, apiPassword } = await syncStep<{
      apiUser: string;
      apiPassword: string;
    }>("apiCredentials", async () => {
      return {
        apiUser: `spacelift_flows_${input.block.id.substring(0, 8)}`,
        apiPassword: generateApiPassword(),
      };
    });

    const restMessageName = `Spacelift_Flows_${input.block.id.substring(0, 8)}`;

    // 4. Create REST Message (idempotent)
    const restMessageResource = await syncStep<CreatedResource>(
      "restMessageResource",
      async () => {
        return await createRestMessage(credentials, {
          name: restMessageName,
          authUser: apiUser,
          authPassword: apiPassword,
        });
      },
    );

    // 5. Create REST Message Function (idempotent)
    const restMessageFnName = "CallFlows";
    const restMessageFnResource = await syncStep<CreatedResource>(
      "restMessageFnResource",
      async () => {
        return await createRestMessageFunction(credentials, {
          restMessageId: restMessageResource.id,
          name: restMessageFnName,
          endpoint: `${input.block.http?.url}/request`,
          httpMethod: "POST",
        });
      },
    );

    // 6. Create variables (idempotent for each variable)
    const variableResources: CreatedResource[] = [];
    const variablesArray = variables as CatalogVariable[];

    for (let i = 0; i < variablesArray.length; i++) {
      const variable = variablesArray[i];

      const variableResource = await syncStep<CreatedResource>(
        `variable-${i}-${variable.name}`,
        async () => {
          return await createVariable(credentials, {
            catalogItemId: catalogItemResource.id,
            name: variable.name,
            type: mapVariableType(variable.type),
            label: variable.label,
            description: variable.description,
            required: variable.required,
            defaultValue: variable.default,
          });
        },
      );
      variableResources.push(variableResource);

      // Create question choices for select variables (idempotent for each choice)
      if (
        variable.type === "select" &&
        variable.options &&
        variable.options.length > 0
      ) {
        for (let j = 0; j < variable.options.length; j++) {
          const option = variable.options[j];
          const choiceResource = await syncStep<CreatedResource>(
            `variable-${i}-${variable.name}-choice-${j}`,
            async () => {
              return await createQuestionChoice(credentials, {
                questionId: variableResource.id,
                value: option,
              });
            },
          );
          variableResources.push(choiceResource);
        }
      }
    }

    // 7. Create business rule (idempotent)
    const businessRuleResource = await syncStep<CreatedResource>(
      "businessRuleResource",
      async () => {
        const script = generateBusinessRuleScript({
          catalogItemName: catalogItemName as string,
          restMessageName,
          restMessageFnName,
        });

        return await createBusinessRule(credentials, {
          name: `Spacelift Flows - ${catalogItemName}`,
          catalogItemId: catalogItemResource.id,
          script,
        });
      },
    );

    // Build complete list of created resources for cleanup
    const createdResources: CreatedResource[] = [
      catalogItemResource,
      restMessageResource,
      restMessageFnResource,
      ...variableResources,
      businessRuleResource,
    ];

    // Store metadata for http handler and cleanup (idempotent)
    await syncStep<boolean>("finalMetadataStorage", async () => {
      await kv.block.setMany([
        { key: "catalogItemId", value: catalogItemResource.id },
        { key: "apiUser", value: apiUser },
        { key: "apiPassword", value: apiPassword },
        { key: "restMessageName", value: restMessageName },
        { key: "restMessageFnName", value: restMessageFnName },
        { key: "createdResources", value: createdResources },
      ]);
      return true;
    });

    console.log("✓ Catalog item fully configured and ready");

    return {
      newStatus: "ready",
      signalUpdates: {
        catalogItemId: catalogItemResource.id,
        catalogItemUrl: `${instanceUrl}/sc_cat_item.do?sys_id=${catalogItemResource.id}`,
      },
    };
  },

  async onDrain(input) {
    const { accessToken } = input.app.signals;
    const instanceUrl = input.app.config.instanceUrl;

    if (!accessToken) {
      // If no auth, just clean up local state including syncStep keys
      // We need to clean up all possible syncStep keys
      const keysToDelete = [
        "catalogItemId",
        "apiUser",
        "apiPassword",
        "restMessageName",
        "restMessageFnName",
        "createdResources",
        // syncStep keys from onSync
        "categorySysId",
        "catalogItemResource",
        "apiCredentials",
        "restMessageResource",
        "restMessageFnResource",
        "businessRuleResource",
        "finalMetadataStorage",
      ];

      // Also clean up variable-related and deletion syncStep keys
      const allKeys = await kv.block.list({ keyPrefix: "" });
      for (const pair of allKeys.pairs) {
        if (
          pair.key.startsWith("variable-") ||
          pair.key.startsWith("deleted-") ||
          pair.key === "deleted-catalog-item"
        ) {
          keysToDelete.push(pair.key);
        }
      }

      await kv.block.delete(keysToDelete);
      return {
        newStatus: "drained",
        signalUpdates: {
          catalogItemId: null,
          catalogItemUrl: null,
        },
      };
    }

    const credentials: ServiceNowCredentials = {
      instanceUrl: instanceUrl as string,
      accessToken: accessToken as string,
    };

    console.log("Draining catalog item resources...");

    // Get all created resources
    const { value: createdResources } = await kv.block.get("createdResources");
    const { value: catalogItemId } = await kv.block.get("catalogItemId");

    // Delete all created resources (idempotent)
    if (createdResources && Array.isArray(createdResources)) {
      for (const resource of createdResources) {
        await syncStep<boolean>(
          `deleted-${resource.type}-${resource.id}`,
          async () => {
            try {
              await deleteTableRecord(credentials, resource.type, resource.id);
              console.log(`✓ Deleted resource ${resource.type}/${resource.id}`);
              return true;
            } catch (error) {
              console.warn(
                `Failed to delete resource ${resource.type}/${resource.id}:`,
                error,
              );
              // Return true anyway - resource might already be deleted or doesn't exist
              return true;
            }
          },
        );
      }
    }

    // Delete the catalog item itself (idempotent)
    if (catalogItemId) {
      await syncStep<boolean>("deleted-catalog-item", async () => {
        try {
          await deleteTableRecord(credentials, "sc_cat_item", catalogItemId);
          console.log(`✓ Deleted catalog item ${catalogItemId}`);
          return true;
        } catch (error) {
          console.warn(
            `Failed to delete catalog item ${catalogItemId}:`,
            error,
          );
          // Return true anyway - might already be deleted
          return true;
        }
      });
    }

    console.log("✓ All resources deleted");

    // Clean up ALL local storage including syncStep keys
    // We list all keys and delete them to ensure complete cleanup
    const allKeys = await kv.block.list({ keyPrefix: "" });
    const keysToDelete = allKeys.pairs.map((pair) => pair.key);

    if (keysToDelete.length > 0) {
      await kv.block.delete(keysToDelete);
      console.log(`✓ Cleaned up ${keysToDelete.length} KV storage keys`);
    }

    return {
      newStatus: "drained",
      signalUpdates: {
        catalogItemId: null,
        catalogItemUrl: null,
      },
    };
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
        const credentials = Buffer.from(base64Credentials, "base64").toString(
          "utf-8",
        );
        const [username, password] = credentials.split(":");

        const [{ value: storedUser }, { value: storedPassword }] =
          await kv.block.getMany(["apiUser", "apiPassword"]);

        if (
          !storedUser ||
          !storedPassword ||
          username !== storedUser ||
          password !== storedPassword
        ) {
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

        // Update the request item in ServiceNow to show it was received
        const requestItemId = payload.metadata.requestItemId;
        const accessToken = input.app.signals.accessToken;
        const instanceUrl = input.app.config.instanceUrl;

        if (accessToken && instanceUrl && requestItemId) {
          try {
            const updateUrl = `${instanceUrl}/api/now/table/sc_req_item/${requestItemId}`;
            const updateResponse = await fetch(updateUrl, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                comments: "Request received by Spacelift Flows for processing",
              }),
            });

            if (!updateResponse.ok) {
              console.warn(
                `Failed to update ServiceNow request item ${requestItemId}: ${updateResponse.status}`,
              );
            } else {
              console.log(
                `✓ Added comment to ServiceNow request item ${requestItemId}`,
              );
            }
          } catch (error: any) {
            console.warn(
              `Failed to update ServiceNow request item: ${error.message}`,
            );
            // Don't fail the whole request if the update fails
          }
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
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  const randomValues = new Uint8Array(32);
  crypto.getRandomValues(randomValues);

  return Array.from(randomValues)
    .map((value) => chars[value % chars.length])
    .join("");
}
