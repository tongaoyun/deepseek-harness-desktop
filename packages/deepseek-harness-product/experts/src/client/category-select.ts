import React from 'react'
import { Menu, Button, IconChevronDownOutlineRegular, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** 设置筛选和专家编辑共用的分类选择选项。 */
export interface CategoryOption {
  readonly value: string
  readonly label: string
}

/** 分类选择沿用原生菜单；禁用关闭菜单，恢复启用后等待重新打开。 */
export function CategorySelect(props: {
  readonly id: string
  readonly value: string
  readonly disabled?: boolean
  readonly label?: string
  readonly options: ReadonlyArray<CategoryOption>
  readonly onChange: (value: string) => void
}): React.ReactElement {
  const [requestedOpen, setOpen] = React.useState(false)
  const open = requestedOpen && !props.disabled
  React.useLayoutEffect(() => {
    if (props.disabled) setOpen(false)
  }, [props.disabled])

  const selectedOption = props.options.find((opt) => opt.value === props.value)
  const currentText = selectedOption ? selectedOption.label : (props.label || props.value || '')

  const items = React.useMemo<readonly MenuEntry[]>(() => {
    return props.options.map((opt) => ({
      id: opt.value,
      label: opt.label,
    }))
  }, [props.options])

  return React.createElement('div', { className: 'aag-select-wrap', style: { display: 'inline-block' } },
    React.createElement(Menu, {
      open,
      onClose: () => setOpen(false),
      onSelect: (id: string) => {
        props.onChange(id)
        setOpen(false)
      },
      selectedId: props.value,
      align: 'start',
      portal: true,
      dense: true,
      anchor: React.createElement(Button, {
        id: props.id,
        variant: 'outline',
        size: 'sm',
        'aria-label': props.label,
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        disabled: props.disabled,
        className: 'aag-menu-select-trigger',
        onClick: () => {
          setOpen((prev) => !prev)
        },
      },
      React.createElement('span', { className: 'aag-select-label' }, currentText),
      React.createElement(IconChevronDownOutlineRegular, {
        className: 'aag-native-select-arrow',
        size: 12,
      })),
      items,
    })
  )
}
