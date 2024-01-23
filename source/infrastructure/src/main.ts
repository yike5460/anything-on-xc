import { App, CfnOutput, CfnParameter, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EC2Stack } from '../lib/common/ec2-stack';

export class StableDiffusionStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // cfn parameters dropdown list for ec2 instance type
    const _ec2InstaceType = new CfnParameter(this, 'ec2InstanceType', {
      type: 'String',
      description: 'EC2 instance type',
      default: 'g5.4xlarge',
      allowedValues: [
        'g5.2xlarge',
        'g5.4xlarge',
      ],
    });

    const _ec2Stack = new EC2Stack(this, 'ec2-stack', {
      ec2InstanceType: _ec2InstaceType.valueAsString,
      env: props.env,
    });

    // output the EC2 instance id and ALB DNS name

  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new StableDiffusionStack(app, 'stable-diffusion-on-ec2-dev', { env: devEnv });
// new MyStack(app, 'stable-diffusion-on-ec2-prod', { env: prodEnv });

app.synth();