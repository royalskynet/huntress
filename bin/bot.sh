#!/bin/bash
# launchd com.agentid.bot：KeepAlive 常駐 long-poll
exec /bin/bash /Users/you/dev/agentid-newlaunch/bin/launch.sh bin/bot-poll.sh
