/** Shapes shared by the phone app and the server. Everything here is stored on the phone only. */

export type Profile = {
  name: string;
  goals: string;
  moneyTarget: string;
  habits: string;
};

export type ChatTurn = { role: "user" | "future"; text: string };

export type ChatRequest = {
  mode: "talk" | "checkin";
  profile: Profile;
  message: string;
  history: ChatTurn[];
  recentWins: string[];
  streak: number;
  checkin?: { yesterday: string; move: string };
  localTime?: string;
};

export type ChatResponse = { reply: string; win: string | null } | { error: string };
