export interface Session {
  id: string;
  name: string;
  status: string;
  working_dir: string;
}

export type LayoutMode = "single" | "grid";
