export class AppError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "AppError";
	}
}

export class ConfigError extends AppError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR");
		this.name = "ConfigError";
	}
}
