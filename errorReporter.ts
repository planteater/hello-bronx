import * as Sentry from "@sentry/node";
import { Severity } from "@sentry/node";
import * as os from "os";
import { Team } from "./api/extensions";
import { SessionContainer } from "./container";
import {
	CodeStreamEnvironment,
	ReportMessageRequest,
	ReportMessageRequestType
} from "./protocol/agent.protocol";
import { CodeStreamSession, SessionStatus } from "./session";
import { lsp, lspHandler } from "./system";

@lsp
export class ErrorReporter {
	constructor(session: CodeStreamSession) {
		if (session.environment === CodeStreamEnvironment.Production) {
			Sentry.init({
				dsn: "https://7c34949981cc45848fc4e3548363bb17@sentry.io/1314159",
				release: session.versionInfo.extension.versionFormatted,
				environment: session.environment
			});

			Sentry.configureScope(scope => {
				scope.setTag("platform", os.platform());
				scope.setTag("ide", session.versionInfo.ide.name);
				scope.setTag("ideDetail", session.versionInfo.ide.detail);
				scope.setExtra("ideVersion", session.versionInfo.ide.version);
				scope.setTag("source", "agent");
			});

			session.onDidChangeSessionStatus(event => {
				if (event.getStatus() === SessionStatus.SignedOut) return;

				Sentry.configureScope(async scope => {
					const team = await SessionContainer.instance().teams.getById(session.teamId);
					//  TODO: acknowledge telemetryConsent
					scope.setUser({
						id: session.userId,
						email: session.email,
						team: {
							id: team.id,
							name: team.name,
							provider: Team.isSlack(team)
								? "Slack"
								: Team.isMSTeams(team)
								? "MSTeams"
								: "CodeStream"
						}
					});
				});
			});
		}
	}

	@lspHandler(ReportMessageRequestType)
	reportMessage(request: ReportMessageRequest) {
		Sentry.captureEvent({
			level: Severity.fromString(request.type),
			timestamp: Date.now(),
			message: request.message,
			extra: request.extra,
			tags: {
				source: request.source
			}
		});
	}
}
