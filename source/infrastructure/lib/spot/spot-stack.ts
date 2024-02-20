import { NestedStack, StackProps, Duration, Aws, RemovalPolicy, Expiration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

import * as path from 'path';
import * as fs from 'fs';

interface spotStackProps extends StackProps {
    // Placeholder for spot price
    spotPrice: number;
    launchTemplateId: string;
}

export class SpotStack extends NestedStack {

    // _spotPrice;
    constructor(scope: Construct, id: string, props: spotStackProps) {
        super(scope, id, props);

        /* User Lambda and cron job in event bridge to monitor the Spot Instance Pricing History and Implement a dynamic bidding strategy that adjusts the maxPrice setting accordingly based on current market conditions:

        1. Create a Lambda function that retrieves the Spot Instance Pricing History and calculates the optimal maxPrice.
        2. Set up an EventBridge rule to trigger the Lambda function at regular intervals (e.g., every hour).
        3. Store the optimal maxPrice in an SSM Parameter Store parameter.
        */

        // Lambda function to retrieve the Spot Instance Pricing History and calculate the optimal maxPrice
        const _spotPriceLambda = new lambda.Function(this, 'spotPriceLambda', {
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'spotPrice.lambda_handler',
            code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
            environment: {
                // Set the region to retrieve the Spot Instance Pricing History
                REGION: Aws.REGION,
                // Set the launch template ID
                LAUNCH_TEMPLATE_ID: props.launchTemplateId,
            },
        });

        // Grant the Lambda function permission to retrieve the Spot Instance Pricing History
        _spotPriceLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'ec2:DescribeSpotPriceHistory',
            ],
            resources: ['*'],
        }));

        // Grant the Lambda function permissions to put a parameter
        _spotPriceLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'ssm:PutParameter',
            ],
            resources: ['*'],
        }));

        // Grant the Lambda function permissions to EC2 launch template
        _spotPriceLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'ec2:DescribeLaunchTemplates',
                'ec2:DescribeLaunchTemplateVersions',
                'ec2:CreateLaunchTemplateVersion',
                'ec2:ModifyLaunchTemplate',
            ],
            resources: ['*'],
        }));
        // Store the optimal maxPrice in an SSM Parameter Store parameter
        const _maxPriceParameter = new ssm.StringParameter(this, 'SpotPriceParameter', {
            stringValue: '0.5',
            parameterName: 'SpotInstanceMaxPrice',
            description: 'The maximum price to bid for Spot Instances',
        });

        // EventBridge rule to trigger the Lambda function every hour
        const _spotPriceRule = new events.Rule(this, 'Rule', {
            schedule: events.Schedule.expression('cron(0 * * * ? *)'), // runs every hour
          });

        // Set the Lambda function as the target for the EventBridge rule
        _spotPriceRule.addTarget(new targets.LambdaFunction(_spotPriceLambda));

        // this._spotPrice = 
    }
}