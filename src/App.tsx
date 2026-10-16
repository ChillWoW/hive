import { TopBar } from "@/layout";

export function App() {
    return (
        <div className="flex h-full w-full flex-col bg-dark-900 text-dark-50">
            <TopBar />
            <main className="min-h-0 w-full flex-1 overflow-hidden" />
        </div>
    );
}
