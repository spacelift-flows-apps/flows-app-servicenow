import { defineApp, kv, lifecycle, AppInput, AppLifecycleCallbackOutput } from "@slflows/sdk/v1";
import { blocks } from "./blocks/index";

// Key value store keys
const KV_KEYS = {
  ACCESS_TOKEN: "accessToken",
  EXPIRES_AT: "expiresAt",
  CONFIG_CHECKSUM: "configChecksum",
};

// Constants
const REFRESH_BUFFER_SECONDS = 300; // Refresh 5 minutes before expiration

export const app = defineApp({
  name: "ServiceNow",

  signals: {
    accessToken: {
      name: "Access Token",
      description: "ServiceNow OAuth2 access token for authenticated API requests",
      sensitive: true,
    },
  },

  installationInstructions: `To set up this ServiceNow app with OAuth2:

1. **Create OAuth2 Application in ServiceNow**:
   - Navigate to System OAuth → Application Registry
   - Click "New" and select "Create an OAuth API endpoint for external clients"
   - Name: "Spacelift Flows Integration"
   - Client ID and Client Secret will be generated - copy these
   - Grant type: Password
   - Required scopes: Select appropriate scopes for Table API access

2. **Create ServiceNow User with Required Permissions**:
   - Create a dedicated integration user or use existing account
   - Required roles:
     - \`rest_service\` - For REST API access
     - \`itil\` - For Service Catalog management
     - \`catalog_admin\` - For creating/managing catalog items

3. **Configure the Installation**:
   - ServiceNow Instance URL: Your instance URL (e.g., https://dev12345.service-now.com)
   - Client ID: From step 1
   - Client Secret: From step 1
   - Username: ServiceNow username
   - Password: ServiceNow password
   - Save the configuration

4. **Use the Integration**:
   - The app will authenticate and provide an access token signal
   - Add "Catalog Item Handler" blocks to create ServiceNow catalog items
   - Each block creates a catalog item that triggers your Flows when requested`,

  config: {
    instanceUrl: {
      name: "ServiceNow Instance URL",
      description: "Your ServiceNow instance URL (e.g., https://dev12345.service-now.com)",
      type: "string",
      required: true,
    },
    clientId: {
      name: "OAuth2 Client ID",
      description: "Client ID from ServiceNow OAuth application",
      type: "string",
      required: true,
    },
    clientSecret: {
      name: "OAuth2 Client Secret",
      description: "Client Secret from ServiceNow OAuth application",
      type: "string",
      required: true,
      sensitive: true,
    },
    username: {
      name: "ServiceNow Username",
      description: "ServiceNow user account for API access",
      type: "string",
      required: true,
    },
    password: {
      name: "ServiceNow Password",
      description: "Password for ServiceNow user account",
      type: "string",
      required: true,
      sensitive: true,
    },
  },

  async onSync(input: AppInput): Promise<AppLifecycleCallbackOutput> {
    try {
      const config = input.app.config;

      // Validate required config
      if (!config.instanceUrl || !config.clientId || !config.clientSecret || !config.username || !config.password) {
        return {
          newStatus: "failed",
          customStatusDescription: "Missing required configuration fields",
        };
      }

      // Check if token needs refresh
      const needsRefresh = await shouldRefreshToken(config);

      if (!needsRefresh) {
        // Token still valid, no update needed
        return { newStatus: "ready" };
      }

      // Generate new token
      const newToken = await generateToken(config);

      return {
        newStatus: "ready",
        signalUpdates: {
          accessToken: newToken.accessToken,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to sync ServiceNow app:", errorMessage);

      return {
        newStatus: "failed",
        customStatusDescription: `ServiceNow sync failed: ${errorMessage}`,
      };
    }
  },

  schedules: {
    refreshToken: {
      description: "Refreshes ServiceNow OAuth2 token before it expires",
      customizable: false,
      definition: {
        type: "frequency",
        frequency: {
          interval: 10,
          unit: "minutes",
        },
      },
      async onTrigger(input) {
        try {
          const expiresAt = input.app.signals.expiresAt;

          if (!expiresAt) {
            await lifecycle.sync();
            return;
          }

          const now = Date.now();
          const refreshThreshold = now + REFRESH_BUFFER_SECONDS * 1000;

          if (expiresAt < refreshThreshold) {
            await lifecycle.sync();
          }
        } catch (error) {
          console.error("Error in token refresh schedule:", error);
        }
      },
    },
  },

  blocks,
});

// Helper Functions

async function shouldRefreshToken(config: any): Promise<boolean> {
  const [{ value: expiresAt }, { value: previousChecksum }] = await kv.app.getMany([
    KV_KEYS.EXPIRES_AT,
    KV_KEYS.CONFIG_CHECKSUM,
  ]);

  // Check if config changed
  const currentChecksum = await generateChecksum(config);
  const configChanged = !previousChecksum || currentChecksum !== previousChecksum;

  // Check if token expired or close to expiring
  const now = Date.now();
  const refreshThreshold = now + REFRESH_BUFFER_SECONDS * 1000;
  const needsRefresh = !expiresAt || expiresAt < refreshThreshold;

  // Refresh if config changed or expiring soon
  return configChanged || needsRefresh;
}

async function generateToken(config: any) {
  try {
    const tokenUrl = `${config.instanceUrl}/oauth_token.do`;

    // Build request body for password grant
    const body = new URLSearchParams();
    body.append("grant_type", "password");
    body.append("client_id", config.clientId);
    body.append("client_secret", config.clientSecret);
    body.append("username", config.username);
    body.append("password", config.password);

    // Make token request
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token request failed with status ${response.status}: ${errorText}`);
    }

    const tokenResponse = await response.json();

    if (!tokenResponse.access_token) {
      throw new Error("Token response missing access_token field");
    }

    // Calculate expiration time
    const expiresIn = tokenResponse.expires_in ? parseInt(tokenResponse.expires_in, 10) : 3600; // Default to 1 hour
    const expiresAt = Date.now() + expiresIn * 1000;

    // Store config checksum
    const configChecksum = await generateChecksum(config);
    await kv.app.setMany([
      { key: KV_KEYS.EXPIRES_AT, value: expiresAt },
      { key: KV_KEYS.CONFIG_CHECKSUM, value: configChecksum },
    ]);

    return {
      accessToken: tokenResponse.access_token,
      expiresAt,
    };
  } catch (error) {
    console.error("ServiceNow token generation failed:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function generateChecksum(obj: any): Promise<string> {
  const configString = JSON.stringify(obj);
  const buffer = new TextEncoder().encode(configString);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);

  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
