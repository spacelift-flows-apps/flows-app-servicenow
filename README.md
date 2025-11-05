# ServiceNow Flows App

Integrate ServiceNow Service Catalog with Spacelift Flows. Create catalog items that trigger Flows workflows when users request services.

## Features

- **OAuth2 Client Credentials**: Modern machine-to-machine authentication
- **Dynamic Catalog Items**: Create ServiceNow catalog items with custom variables
- **Secure Authentication**: Uses ServiceNow REST Messages to store credentials securely
- **Request Automation**: Automatically triggers Flows when catalog items are requested
- **Status Updates**: Update ServiceNow request status from your Flows

## Quick Start

### 0. Enable Client Credentials Grant (REQUIRED FIRST!)

⚠️ **This is disabled by default in ServiceNow and WILL cause 401 errors if not enabled!**

1. Navigate to **System Properties → OAuth** (or type `sys_properties.list` in filter navigator)
2. Search for property: `glide.oauth.inbound.client.credential.grant_type.enabled`
3. Set the value to **true**
4. Click **Save**

**Quick way to find it**:
- Filter navigator → type `sys_properties.list` → Enter
- Use browser Ctrl+F to search for "client.credential" on the page
- Or add filter: "Name" "contains" "oauth.inbound.client"

### 1. Create ServiceNow User for OAuth

ServiceNow requires an "OAuth Application User" even for client credentials grant. This user's permissions determine what the API can do.

1. Navigate to **User Administration → Users**
2. Click **New** to create a user
3. Fill in:
   - **User ID**: `spacelift_integration` (or your choice)
   - **First name**: Spacelift
   - **Last name**: Integration
   - **Email**: Your email
   - **Password**: Set any password (won't be used for auth, but required by ServiceNow)
4. Click **Submit**
5. On the user record, scroll to **Roles** section
6. Click **Edit** and add these roles:
   - `rest_service` - For REST API access
   - `itil` - For Service Catalog operations
   - `catalog_admin` - For managing catalog items
   - `admin` - For creating business rules and REST messages
7. Click **Save**

### 2. Create OAuth Integration in ServiceNow

1. Navigate to **System OAuth → Integrations**
2. Click **New**
3. Select **OAuth - Client credentials grant** (for machine-to-machine access)
4. Fill in:
   - **Name**: Spacelift Flows Integration
   - **Default Grant type**: Client Credentials
   - **OAuth Application User**: ⚠️ **REQUIRED** - Select the user from step 1
   - **Accessible from**: All application scopes
   - **Active**: ✓ Check this box
5. Click **Submit**
6. **Important**: Copy the **Client ID** and **Client Secret** that are generated

### 3. Install and Configure in Flows

1. Add the ServiceNow app in Flows
2. Configure:
   - **ServiceNow Instance URL**: `https://dev12345.service-now.com` (no trailing slash!)
   - **OAuth2 Client ID**: From step 2
   - **OAuth2 Client Secret**: From step 2
3. Click **Confirm**
4. Wait for app to sync to "Ready" status

### 4. Create a Catalog Item Handler Block

1. Add **Catalog Item Handler** block to your flow
2. Configure:
   - **Catalog Item Name**: e.g., "Request Development Server"
   - **Description**: Brief description
   - **Variables**: Define form fields (see example below)
3. Confirm and wait for block to sync

### 5. Test in ServiceNow

1. Go to ServiceNow **Self-Service → Service Catalog**
2. Find your catalog item
3. Fill out the form and submit
4. Check Flows for the triggered event

## Example Variables Configuration

```json
[
  {
    "name": "server_name",
    "type": "string",
    "label": "Server Name",
    "description": "Name for the server",
    "required": true
  },
  {
    "name": "environment",
    "type": "select",
    "label": "Environment",
    "required": true,
    "options": ["Development", "Staging", "Production"]
  },
  {
    "name": "cpu_count",
    "type": "number",
    "label": "CPU Cores",
    "required": true,
    "default": "2"
  },
  {
    "name": "notes",
    "type": "text",
    "label": "Notes",
    "required": false
  }
]
```

## Troubleshooting

### OAuth Token Error: 401 access_denied

**Symptoms**: App fails to sync with error: `Token request failed with status 401: {"error_description":"access_denied","error":"server_error"}`

**Root Causes (in order of likelihood)**:

1. **⚠️ Client Credentials Grant Not Enabled** (MOST COMMON):
   - ServiceNow shows: "The following property is currently disabled: 'glide.oauth.inbound.client.credential.grant_type.enabled'"
   - **Fix**: Enable the property (see Step 0 above)

2. **⚠️ OAuth Application User Not Set**:
   - The OAuth integration has an empty "OAuth Application User" field
   - **Fix**: Edit the OAuth integration and select a user from the dropdown

3. **User Lacks Permissions**:
   - The OAuth Application User doesn't have required roles
   - **Fix**: Add roles to the user (rest_service, itil, catalog_admin, admin)

4. **Integration Not Active**:
   - The "Active" checkbox is unchecked
   - **Fix**: Edit the integration and check "Active"

**Debugging Steps**:

1. **Check Flows Logs** - Now includes detailed debugging:
   ```
   Attempting OAuth token request to: https://...
   Using client_id: 2bd83f32...
   Request body: grant_type=client_credentials&client_id=...&client_secret=***
   Content-Type: application/x-www-form-urlencoded
   [Either "Token request successful" or error details]
   ```

2. **Verify OAuth Integration**:
   - Go to **System OAuth → Integrations**
   - Find your integration
   - Verify ALL of these:
     - ✅ Status: **Active**
     - ✅ Grant type: **Client credentials**
     - ✅ OAuth Application User: **Set to a user**
     - ✅ Accessible from: **All application scopes**

3. **Test OAuth Manually** (using the exact credentials):
   ```bash
   curl -X POST https://yourinstance.service-now.com/oauth_token.do \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET"
   ```

   Should return:
   ```json
   {
     "access_token": "...",
     "scope": "",
     "token_type": "Bearer",
     "expires_in": 1799
   }
   ```

### Catalog Item Not Visible

**Check**:
1. Go to **Service Catalog → Catalog Items** in ServiceNow
2. Search for your catalog item name
3. Verify it exists and is **Active**
4. Check the **Category** field - if it's in a specific category, navigate to that category in the catalog

### Catalog Item Request Doesn't Trigger Flows

**Debugging**:

1. **Check Business Rule**:
   - Go to **System Definition → Business Rules**
   - Search for "Spacelift Flows"
   - Open your business rule
   - Verify:
     - Status is **Active**
     - When: **async**
     - Table: **sc_req_item**
     - Condition contains your catalog item ID

2. **Check Business Rule Execution**:
   - Go to **System Logs → System Log → All**
   - Filter by "Spacelift Flows" in the message
   - Look for log entries when you submit a catalog item request
   - Check for errors

3. **Verify REST Message**:
   - Go to **System Web Services → Outbound → REST Messages**
   - Find the message starting with `Spacelift_Flows_`
   - Open it and check:
     - Authentication: Basic Auth is configured
     - Credentials are set
   - Check the **HTTP Methods** tab:
     - Endpoint URL should point to your Flows block

4. **Test REST Message Manually**:
   - Open the REST Message
   - Go to **HTTP Methods** tab
   - Click on the function
   - Click **Test** link
   - Check if it can reach the Flows endpoint

### Block Fails to Sync

**Check Logs**: Look for specific errors in the block logs:
- "Authentication failed" - Check app-level OAuth config
- "Failed to create catalog item" - Check ServiceNow permissions
- "Failed to create business rule" - User needs admin role

**Verify Permissions**: The OAuth Application User needs roles to:
- Create catalog items (`sc_cat_item`)
- Create variables (`item_option_new`)
- Create business rules (`sys_script`)
- Create REST messages (`sys_rest_message`)

## Architecture

### Authentication Flow
1. App uses OAuth2 Client Credentials Grant
2. Requests access token from ServiceNow
3. Uses token for all API operations
4. Token refreshed automatically every 10 minutes

### Catalog Item Creation Flow
1. Block creates catalog item via ServiceNow Table API
2. Creates variables (form fields) for the catalog item
3. Creates REST Message with Basic Auth credentials (stored securely)
4. Creates REST Message Function pointing to block endpoint
5. Creates Business Rule that triggers on item submission
6. Business Rule uses REST Message to call Flows (no secrets in script!)

### Request Processing Flow
1. User submits catalog item in ServiceNow
2. Business Rule triggers and extracts variables
3. Business Rule calls Flows block endpoint via REST Message
4. Flows validates Basic Auth and emits event
5. Your flow processes the event
6. (Optional) Flow updates request status in ServiceNow

## Security

- **OAuth2**: Modern client credentials grant
- **Secrets in REST Message**: Credentials stored in ServiceNow's credential store, not in scripts
- **Basic Auth**: Block endpoint validates incoming requests
- **Per-block credentials**: Each block gets unique API credentials

## Variable Types

Supported variable types:
- `string` - Single line text
- `text` - Multi-line text area
- `boolean` - Checkbox
- `number` - Number input (rendered as text field in ServiceNow)
- `select` - Dropdown with predefined options
- `password` - Masked password field

## Blocks

### Catalog Item Handler

Creates a ServiceNow catalog item with custom variables. When users request the item in ServiceNow, triggers a Flows event.

**Signals**:
- `catalogItemId` - ServiceNow sys_id of the created catalog item
- `catalogItemUrl` - Direct URL to view/edit the catalog item

**Output**: Emits event with request details and all form variables

### Update Request Status

Updates a ServiceNow request item status and adds comments.

**States**: PENDING, WORK_IN_PROGRESS, COMPLETED, FAILED, CANCELLED

**Outputs**:
- `default` - Success output
- `error` - Error output

## Development

```bash
npm install
npm run typecheck
npm run format
```
