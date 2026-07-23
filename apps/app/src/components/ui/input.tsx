import * as React from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none transition-shadow',
        'placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
