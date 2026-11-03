import type * as React from "react";
import type { Translate } from "./client-types.ts";
import type { WorkspaceRow } from "./core.ts";
import type { RepositoryDestination } from "./types.ts";

/** 目标选择：用户目录（默认）或指定的已登记工作区。位置只在用户目录下才有两项可选。 */
export type DestinationScope = "user" | "workspace";
export interface DestinationValue {
  scope: DestinationScope;
  location: "dsh" | "agents";
  /** 已登记工作区路径；用户目录下为空串。 */
  workspace: string;
}
export type UserDestination = RepositoryDestination;
export interface DestinationPickerProps {
  t: Translate;
  value: DestinationValue;
  onChange: (next: Partial<DestinationValue>) => void;
  workspaces: readonly WorkspaceRow[];
  userDestinations: readonly UserDestination[];
  /** 是否允许用户目录中的 Shared Agent 目标。 */
  allowAgents: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** 工作区读取失败时保留原因，不能显示为已确认的空目录。 */
  workspaceError?: string | null;
  onRetryWorkspaces?: () => void;
}
export type DestinationPickerComponent = React.ComponentType<DestinationPickerProps>;
/** 注入给各入口的一套选择器能力，保证三处共用同一实现。 */
export interface DestinationKit {
  DestinationPicker: DestinationPickerComponent;
  defaultDestination: () => DestinationValue;
  destinationPayload: (value: DestinationValue) => { root?: "dsh" | "agents"; workspace?: string };
  destinationReady: (value: DestinationValue, workspaces: readonly WorkspaceRow[], userDestinations?: readonly UserDestination[]) => boolean;
}
