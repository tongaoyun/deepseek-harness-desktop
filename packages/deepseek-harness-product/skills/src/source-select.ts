import type * as React from "react";
import type { SourceSelectProps } from "./client-types.ts";
import { Menu, Button, IconChevronDownOutlineRegular, type MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";

/** 筛选与操作沿用原生菜单；禁用关闭菜单，恢复启用后等待重新打开。 */
export function createSourceSelect(react: typeof React) {
  const h = react.createElement;
  return function SourceSelect(props: SourceSelectProps) {
    const [requestedOpen, setOpen] = react.useState(false);
    const open = requestedOpen && !props.disabled;
    react.useLayoutEffect(() => {
      if (props.disabled) setOpen(false);
    }, [props.disabled]);
    function close() { setOpen(false); }
    function select(id: string) { props.onChange(id); close(); }
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
          onClose: close,
          onSelect: select,
          align: "end",
          portal: true,
          anchor: h(Button, {
            variant: "outline",
            size: "sm",
            disabled: props.disabled,
            className: props.icon ? "dssm-icon-action" : undefined,
            style: props.icon ? { width: 22, minWidth: 22, height: 22, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--dsw-radius-sm, 8px)" } : undefined,
            "aria-label": props.label,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            title: props.label,
            onClick: function () { setOpen(prev => !prev); },
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
        onClose: close,
        onSelect: select,
        selectedId: props.value,
        align: "start",
        portal: true,
        dense: true,
        listClassName: "dssm-source-select-menu",
        anchor: h(Button, {
          variant: "outline",
          size: "sm",
          "aria-label": props.label,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          disabled: props.disabled,
          className: "dssm-menu-select-trigger" + (open ? " is-open" : ""),
          onClick: function () { setOpen(prev => !prev); },
        },
          h("span", { className: "dssm-menu-select-label" }, currentText),
          h(IconChevronDownOutlineRegular, {
            className: "dssm-menu-select-arrow",
            size: 12,
          })
        ),
        items: items,
      })
    );
  };
}
