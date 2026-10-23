import { getProviderConnections, updateProviderConnection } from "@/lib/localDb.js";
import { getExecutor } from "open-sse/index.js";
import { storedTokensIfStale } from "@/sse/services/tokenRefresh";

// `refreshedFrom` is the refresh token the new credentials were made with.
async function persistRefreshedCredentials(connection, newCredentials, refreshedFrom) {
  const updateData = {};

  if (newCredentials.accessToken) updateData.accessToken = newCredentials.accessToken;
  if (newCredentials.refreshToken) updateData.refreshToken = newCredentials.refreshToken;
  if (newCredentials.idToken) updateData.idToken = newCredentials.idToken;
  if (newCredentials.lastRefreshAt) updateData.lastRefreshAt = newCredentials.lastRefreshAt;
  if (newCredentials.expiresIn) {
    updateData.expiresIn = newCredentials.expiresIn;
    updateData.expiresAt = new Date(Date.now() + newCredentials.expiresIn * 1000).toISOString();
  } else if (newCredentials.expiresAt) {
    updateData.expiresAt = newCredentials.expiresAt;
  }

  const providerSpecificUpdates = {
    ...(newCredentials.providerSpecificData || {}),
    ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
    ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  if (Object.keys(updateData).length === 0) return null;
  const stored = await updateProviderConnection(connection.id, updateData, { refreshedFrom });
  return storedTokensIfStale(stored, newCredentials);
}

export async function POST(request) {
  try {
    const { provider, model, body } = await request.json();

    if (!provider || !model || !body) {
      return Response.json({ success: false, error: "provider, model, and body required" }, { status: 400 });
    }

    const connections = await getProviderConnections({ provider });
    const connection = connections.find(c => c.isActive !== false);
    if (!connection) {
      return Response.json({ success: false, error: `No active connection for provider: ${provider}` }, { status: 400 });
    }

    const credentials = {
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      lastRefreshAt: connection.lastRefreshAt,
      connectionId: connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
      projectId: connection.projectId,
      providerSpecificData: connection.providerSpecificData
    };

    const executor = getExecutor(provider);
    const stream = body.stream !== false;

    let { response } = await executor.execute({ model, body, stream, credentials });

    // Auto-refresh token on 401/403 and retry (same as chatCore.js)
    if (response.status === 401 || response.status === 403) {
      const refreshedFrom = credentials.refreshToken;
      const newCredentials = await executor.refreshCredentials(credentials, console);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        Object.assign(credentials, newCredentials);
        const stale = await persistRefreshedCredentials(connection, newCredentials, newCredentials.refreshedFrom || refreshedFrom);
        // A refresh that lost a race to newer stored tokens retries with those instead.
        if (stale) Object.assign(credentials, stale);
        ({ response } = await executor.execute({ model, body, stream, credentials }));
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Translator] Provider error ${response.status}:`, errorText.slice(0, 500));
      return Response.json({ success: false, error: `Provider error: ${response.status}`, details: errorText }, { status: response.status });
    }

    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } catch (error) {
    console.error("[Translator] Send error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
