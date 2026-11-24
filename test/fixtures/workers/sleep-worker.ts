export default async function sleepWorker(task: { path: string }): Promise<{ path: string }> {
	if (task.path.includes("slow")) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5000));
	}
	return { path: task.path };
}