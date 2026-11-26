import type { ReactNode } from 'react';

interface WorkspaceShellProps {
  title: string;
  children: ReactNode;
}

export function WorkspaceShell({ title, children }: WorkspaceShellProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="border-b pb-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
      </header>
      <main>{children}</main>
    </div>
  );
}
