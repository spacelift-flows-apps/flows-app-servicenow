import { AppBlock, events } from "@slflows/sdk/v1";

// ServiceNow request item states
const REQUEST_STATES = {
  PENDING: 1,
  WORK_IN_PROGRESS: 2,
  COMPLETED: 3,
  FAILED: 4,
  CANCELLED: 7,
} as const;

type RequestState = keyof typeof REQUEST_STATES;

export const updateRequest: AppBlock = {
  name: "Update Request Status",
  description: "Updates a ServiceNow request item status and adds comments",
  category: "Service Catalog",

  inputs: {
    default: {
      config: {
        requestItemId: {
          name: "Request Item ID",
          description: "ServiceNow request item sys_id to update",
          type: "string",
          required: true,
        },
        state: {
          name: "State",
          description: "New state for the request item",
          type: "string",
          required: true,
          default: "COMPLETED",
        },
        comments: {
          name: "Comments",
          description: "Comments to add to the request item (visible to requester)",
          type: "string",
          required: false,
        },
        workNotes: {
          name: "Work Notes",
          description: "Work notes to add to the request item (internal only)",
          type: "string",
          required: false,
        },
      },
      onEvent: async (input) => {
        const { requestItemId, state, comments, workNotes } = input.event.inputConfig;
        const { accessToken } = input.app.signals;
        const instanceUrl = input.app.config.instanceUrl;

        if (!accessToken) {
          throw new Error("App not authenticated - check app configuration");
        }

        if (!instanceUrl) {
          throw new Error("ServiceNow instance URL not configured");
        }

        if (!requestItemId) {
          throw new Error("Request Item ID is required");
        }

        // Validate state
        const stateValue = REQUEST_STATES[state as RequestState];
        if (stateValue === undefined) {
          throw new Error(
            `Invalid state: ${state}. Valid states are: ${Object.keys(REQUEST_STATES).join(", ")}`
          );
        }

        try {
          // Build update payload
          const updatePayload: any = {
            state: stateValue,
          };

          if (comments) {
            updatePayload.comments = comments;
          }

          if (workNotes) {
            updatePayload.work_notes = workNotes;
          }

          // Update the request item via ServiceNow Table API
          const url = `${instanceUrl}/api/now/table/sc_req_item/${requestItemId}`;

          const response = await fetch(url, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(updatePayload),
          });

          if (response.status === 401) {
            throw new Error("Authentication failed - please check ServiceNow credentials");
          }

          if (response.status === 403) {
            throw new Error("Insufficient permissions to update request items");
          }

          if (response.status === 404) {
            throw new Error(`Request item ${requestItemId} not found`);
          }

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update request: ${response.status} ${errorText}`);
          }

          const data = await response.json();

          // Emit success event with updated request details
          await events.emit({
            success: true,
            requestItemId: requestItemId,
            updatedState: state,
            sysId: data.result.sys_id,
            number: data.result.number,
          });
        } catch (error: any) {
          console.error("Error updating request item:", error.message);

          // Emit failure event
          await events.emit(
            {
              success: false,
              requestItemId: requestItemId,
              error: error.message,
            },
            { outputKey: "error" }
          );

          throw error;
        }
      },
    },
  },

  outputs: {
    default: {
      name: "Success",
      description: "Emitted when the request item is updated successfully",
      default: true,
      type: {
        type: "object",
        properties: {
          success: {
            type: "boolean",
            description: "Whether the update was successful",
          },
          requestItemId: {
            type: "string",
            description: "ServiceNow request item sys_id",
          },
          updatedState: {
            type: "string",
            description: "The new state of the request item",
          },
          sysId: {
            type: "string",
            description: "ServiceNow sys_id of the updated record",
          },
          number: {
            type: "string",
            description: "ServiceNow request item number",
          },
        },
        required: ["success", "requestItemId"],
      },
    },
    error: {
      name: "Error",
      description: "Emitted when the update fails",
      type: {
        type: "object",
        properties: {
          success: {
            type: "boolean",
            description: "Always false for error output",
          },
          requestItemId: {
            type: "string",
            description: "ServiceNow request item sys_id",
          },
          error: {
            type: "string",
            description: "Error message",
          },
        },
        required: ["success", "requestItemId", "error"],
      },
    },
  },
};
