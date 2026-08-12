import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

// Контекстное меню (правый клик). Стиль зеркалит dropdown-menu.
export const ContextMenu = ContextMenuPrimitive.Root
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          'z-50 min-w-44 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
        'focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function ContextMenuCheckItem({
  checked,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { checked?: boolean }) {
  return (
    <ContextMenuItem {...props}>
      <span className="grid size-4 place-items-center">{checked && <Check className="size-3.5 text-brand-ink" />}</span>
      {children}
    </ContextMenuItem>
  )
}

export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cn('px-2 py-1 text-xs text-muted-foreground', className)} {...props} />
}
