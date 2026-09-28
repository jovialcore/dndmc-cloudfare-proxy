// Spam-check proxy for the Do Not Disturb My Comments plugin.
// Holds no secrets: the AI binding bills Jev calls to this Cloudflare account.

// here we are just setting params
const SPAM_QUESTION = {
	type: 'noul',
	instructions: 'Is this blog comment spam ?',
	criteria: {
		true: 'Promotional, SEO link-dropping, phishing, scams, or generic praise unrelated to the post',
		false: 'A genuine reader responding to the post, even if brief or critical',
	},
};

const MAX_LENGTH = {
	post_title: 300,
	author_name: 200,
	author_url: 500,
	content: 5000,
};

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
		},
	});
}

async function readComment(request) {
	let body;
	try {
		body = await request.json();
	} catch (error) {
		return null;
	}

	const comment = {};
	for (const [field, max] of Object.entries(MAX_LENGTH)) {
		const value = typeof body?.[field] === 'string' ? body[field] : '';
		comment[field] = value.slice(0, max);
	}

	return comment.content.trim() ? comment : null;
}

async function askJev(env, comment) {
	const state = [
		`Post title: ${comment.post_title}`,
		`Author name: ${comment.author_name}`,
		`Author website: ${comment.author_url}`,
		'Comment:',
		comment.content,
	].join('\n');

	const output = await env.AI.run('typesafe/jev', {
		state,
		questions: {
			is_spam: SPAM_QUESTION,
		},
	});

	const answers = output?.answers ?? output?.result?.answers;
	const probability = answers?.is_spam?.noul;

	return typeof probability === 'number' ? probability : null;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method !== 'POST' || url.pathname !== '/v1/check') {
			return json({ error: 'not_found' }, 404);
		}

		// one bucket per WordPress server
		const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
		const { success } = await env.SITE_LIMITER.limit({ key: ip });
		if (!success) {
			return json({ error: 'rate_limited' }, 429);
		}

		const comment = await readComment(request);
		if (!comment) {
			return json({ error: 'invalid_request' }, 400);
		}

		try {
			const probability = await askJev(env, comment);
			if (probability === null) {
				return json({ error: 'bad_model_response' }, 502);
			}
			return json({ spam_probability: probability });
		} catch (error) {
			console.error('Jev call failed', error);
			return json({ error: 'upstream_error' }, 502);
		}
	},
};
