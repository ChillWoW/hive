import { Sidebar, TopBar } from "@/layout";

export function App() {
    return (
        <div className="relative flex h-full w-full bg-dark-900 text-dark-50">
            <Sidebar />
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-9"></main>
            <TopBar title="Quick test" />
        </div>
    );
}
