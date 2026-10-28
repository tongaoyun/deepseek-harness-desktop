import type * as React from "react";
import type { SourceSelectProps } from "./client-types.ts";
import { Menu, Button, type MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";

/**
 * 使用原生 Menu 和 Button 的来源筛选与操作菜单；键盘、焦点与弹层归属由原生 Menu 管理。
 * @param react - Product React runtime.
 * @returns Source selection and action menu component.
 */
export function createSourceSelect(react: typeof React) {
  const h = react.createElement;
  return function SourceSelect(props: SourceSelectProps) {
    const openState = react.useState(false);
    const open = openState[0];
    const setOpen = openState[1];

    const items = react.useMemo<readonly MenuEntry[]>(function () {
      return props.options.map(function (opt) {
        return {
          id: opt.value,
          label: opt.label,
          disabled: opt.disabled,
          danger: opt.danger,
        };
      });
    }, [props.options]);

    if (props.action) {
      return h("div", { className: "dssm-action-menu-wrap", style: { display: "inline-block" } },
        h(Menu, {
          open: open,
          onClose: function () { setOpen(false); },
          onSelect: function (id: string) {
            props.onChange(id);
            setOpen(false);
          },
          align: "end",
          portal: true,
          anchor: h(Button, {
            variant: "outline",
            size: "sm",
            disabled: props.disabled,
            className: props.icon ? "dssm-icon-action" : undefined,
            style: props.icon ? { width: 22, minWidth: 22, height: 22, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--dsw-radius-sm, 8px)" } : undefined,
            "aria-label": props.label,
            title: props.label,
            onClick: function () {
              if (!props.disabled) setOpen(function (prev) { return !prev; });
            },
            icon: props.icon,
          }, props.icon ? null : props.label),
          items: items,
        })
      );
    }

    const selectedOption = props.options.find(function (opt) { return opt.value === props.value; });
    const currentText = selectedOption ? selectedOption.label : props.label;

    return h("div", { className: "dssm-menu-select-wrap" },
      h(Menu, {
        open: open,
        onClose: function () { setOpen(false); },
        onSelect: function (id: string) {
          props.onChange(id);
          setOpen(false);
        },
        selectedId: props.value,
        align: "start",
        portal: true,
        dense: true,
        listClassName: "dssm-source-select-menu",
        anchor: h(Button, {
          variant: "outline",
          size: "sm",
          role: "combobox",
          "aria-label": props.label,
          "aria-expanded": open,
          disabled: props.disabled,
          className: "dssm-menu-select-trigger" + (open ? " is-open" : ""),
          onClick: function () {
            if (!props.disabled) setOpen(function (prev) { return !prev; });
          },
        },
          h("span", { className: "dssm-menu-select-label" }, currentText),
          h("svg", {
            className: "dssm-menu-select-arrow",
            viewBox: "0 0 16 16",
            width: 12,
            height: 12,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.8,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            style: { marginLeft: 4, transition: "transform 150ms ease", transform: open ? "rotate(180deg)" : "none" },
          }, h("path", { d: "m4 6 4 4 4-4" }))
        ),
        items: items,
      })
    );
  };
}
