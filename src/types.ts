export interface Session {
  id: string;
  name: string;
  status: string;
  working_dir: string;
  session_type: string;
}

export type LayoutMode = "single" | "grid";
