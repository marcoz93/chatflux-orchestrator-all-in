// Service puro — só funções de I/O

export const login = async (
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> => {
  const res = await fetch(`${baseUrl}/api/next/next/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie;
};

export const assignAutomation = async (
  baseUrl: string,
  conversationId: string,
  botId: string,
  token: string,
): Promise<boolean> => {
  const res = await fetch(`${baseUrl}/api/next/next/assign-automation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `auth_token=${token}`,
    },
    body: JSON.stringify({
      assign_automation: { conversation_id: conversationId, bot_id: botId },
    }),
  });
  return res.ok;
};
