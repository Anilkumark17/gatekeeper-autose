import pino from "pino";

export type LoggerOptions = {
	level: string;
	pretty: boolean;
};

export function createLogger(options: LoggerOptions): pino.Logger {
	return pino({
		level: options.level,
		transport: options.pretty ? { target: "pino-pretty", options: { colorize: true } } : undefined,
	});
}
